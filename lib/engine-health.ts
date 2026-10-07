import { perRequest } from '@/lib/per-request';
import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { now, MINUTE } from '@/lib/clock';
import { agoInWords, exact } from '@/lib/time';
import { isDemoMode } from '@/lib/demo-clock';
import { JOB_NAMES, type JobName } from '@/jobs/definitions';

/** The jobs that are actually on the schedule. See `JOB_CADENCE`. */
type ScheduledJobName = typeof JOB_NAMES[number];

/**
 * Is the engine running?
 *
 * The question matters because of how this system fails. If `CRON_SECRET` is
 * missing or wrong, every cron route answers 401 — and the dashboard carries on
 * looking perfectly healthy, showing countdowns that nothing is counting down.
 * Parcels go back and no screen says why. That failure is invisible by
 * construction, so something has to go looking for it.
 *
 * A SKIPPED run counts as a heartbeat. That is the judgement call here, and it
 * goes this way because of what the question is: not "is work being done" but
 * "is anything running at all". push-heartbeat declining to alert outside
 * working hours, or a daily job finding today already handled, each prove that
 * Vercel fired the route, the secret matched, the database was writable and
 * `runJob` reached the end. Those are exactly the facts a 401, a deleted
 * schedule or an unreachable database would deny us.
 *
 * A FAILED run does not count. A job that throws every half hour proves the
 * scheduler is alive, and is not something to be quiet about.
 */

/** escalation-tick runs every 30 minutes, so 45 is one missed tick plus slack. */
export const QUIET_FOR_TOO_LONG_MS = 45 * MINUTE;

export type EngineHealth =
  | { state: 'healthy'; lastRunAt: Date; lastJob: string; ago: string }
  | { state: 'stopped'; lastRunAt: Date; lastJob: string; ago: string; exactWhen: string }
  | { state: 'never-ran' }
  /** Demo mode moved the clock; silence means nothing. */
  | { state: 'unknown' };

/**
 * Memoised per request because Settings renders inside the panel layout, which
 * already carries the banner: without this the banner and the Connections
 * panel each ask the same question on the same page load.
 */
export const engineHealth = perRequest(async (at: Date = now()): Promise<EngineHealth> => {
  // Demo mode exists to jump the clock. "+1 day" moves `now()` forward
  // twenty-four hours with nothing running in between, which would declare the
  // engine stopped every single time somebody pressed it.
  if (isDemoMode()) return { state: 'unknown' };

  // Ordered by started_at with a LIMIT, which is what job_runs_started_idx is
  // for. `max(started_at) WHERE ok` cannot use the (job, started_at) index —
  // its leading column is wrong and Postgres has no index skip scan — so that
  // obvious-looking query is a sequential scan on every page load.
  const rows = await getDb().execute(raw`
    SELECT job, started_at
      FROM job_runs
     WHERE ok IS TRUE
     ORDER BY started_at DESC
     LIMIT 1
  `);

  const last = rowsOf<{ job: string; started_at: string }>(rows)[0];
  if (!last) return { state: 'never-ran' };

  const lastRunAt = new Date(last.started_at);
  const common = { lastRunAt, lastJob: last.job, ago: agoInWords(lastRunAt, at) };

  if (at.getTime() - lastRunAt.getTime() <= QUIET_FOR_TOO_LONG_MS) {
    return { state: 'healthy', ...common };
  }
  return { state: 'stopped', ...common, exactWhen: exact(lastRunAt) };
});

/* -------------------------------------------------------------------------- */

export interface JobHealth {
  job: ScheduledJobName;
  /** How often it is meant to run, for the screen. */
  cadence: string;
  /** The last run that finished, skip or not. Proof the scheduler fired. */
  lastHeartbeatAt: Date | null;
  lastHeartbeatAgo: string | null;
  lastHeartbeatExact: string | null;
  /** The last run that actually did something. Null if it has only ever skipped. */
  lastRealRunAt: Date | null;
  lastRealRunAgo: string | null;
  /** Set only when the newest attempt of any kind failed. */
  failingSince: Date | null;
  failingSinceAgo: string | null;
}

/**
 * How often each job is meant to run.
 *
 * Written down twice — here and in vercel.json — which is a real cost, so the
 * test suite asserts the two agree rather than trusting anyone to remember.
 *
 * Keyed on the SCHEDULED jobs, not on `JobName`: `push-drain` and
 * `push-heartbeat` still exist and are deliberately off the schedule, so
 * giving them a cadence here would put them back on this screen claiming to
 * run every five minutes when nothing runs them at all.
 */
export const JOB_CADENCE: Record<ScheduledJobName, string> = {
  'escalation-tick': 'every 30 minutes',
  reconcile: 'every 3 hours',
  'shopify-backfill': 'hourly',
  'stale-detector': 'hourly, does the work once a day from 07:30 Madrid',
  'daily-digest': 'hourly, does the work once a day from 08:00 Madrid',
  'import-reminder': 'hourly, does the work once a day from 09:00 Madrid',
  'postcode-stats': 'nightly',
  housekeeping: 'nightly',
};

/**
 * Every job's last heartbeat, last real run, and whether it is currently
 * failing — in one statement.
 *
 * A lateral per job off a VALUES list, so each probe is an index-scan-backward
 * on (job, started_at) with a LIMIT 1 rather than a scan-and-sort of the whole
 * table. The roster comes from the JobName union, not from `SELECT DISTINCT
 * job`: that column is free text and still holds names of jobs that no longer
 * exist, which would leave a dead job on the screen for ever.
 */
export const jobHealth = perRequest(async (at: Date = now()): Promise<JobHealth[]> => {
  // The roster is interpolated as ARRAY[$1, $2, …] one placeholder at a time,
  // rather than handed over as a single array parameter. Passing a JS array
  // into a raw template makes drizzle expand it into a comma list in
  // parentheses — `($1, $2, …)` — which Postgres parses as a ROW, and
  // `unnest(row::text[])` is error 42846, "cannot cast type record to text[]".
  // The screen went 500 on exactly this.
  const roster = raw.join(JOB_NAMES.map((job) => raw`${job}`), raw`, `);

  const rows = await getDb().execute(raw`
    WITH wanted(job) AS (
      SELECT * FROM unnest(ARRAY[${roster}]::text[])
    )
    SELECT w.job,
           beat.started_at AS heartbeat_at,
           real.started_at AS real_at,
           attempt.started_at AS attempt_at,
           attempt.ok        AS attempt_ok
      FROM wanted w
      LEFT JOIN LATERAL (
        SELECT started_at FROM job_runs r
         WHERE r.job = w.job AND r.ok IS TRUE
         ORDER BY r.started_at DESC LIMIT 1
      ) beat ON true
      LEFT JOIN LATERAL (
        SELECT started_at FROM job_runs r
         WHERE r.job = w.job AND r.ok IS TRUE AND r.skipped IS FALSE
         ORDER BY r.started_at DESC LIMIT 1
      ) real ON true
      LEFT JOIN LATERAL (
        SELECT started_at, ok FROM job_runs r
         WHERE r.job = w.job AND r.ok IS NOT NULL
         ORDER BY r.started_at DESC LIMIT 1
      ) attempt ON true
     ORDER BY w.job
  `);

  const list = rowsOf<{
    job: string;
    heartbeat_at: string | null;
    real_at: string | null;
    attempt_at: string | null;
    attempt_ok: boolean | null;
  }>(rows);

  const byJob = new Map(list.map((r) => [r.job, r]));

  return JOB_NAMES.map((job) => {
    const r = byJob.get(job);
    const heartbeat = r?.heartbeat_at ? new Date(r.heartbeat_at) : null;
    const real = r?.real_at ? new Date(r.real_at) : null;
    // Only report a failure if it is the newest thing that happened. Otherwise
    // every job that ever hiccuped carries the scar for ever.
    const failing = r?.attempt_ok === false && r.attempt_at ? new Date(r.attempt_at) : null;

    return {
      job,
      cadence: JOB_CADENCE[job],
      lastHeartbeatAt: heartbeat,
      lastHeartbeatAgo: heartbeat ? agoInWords(heartbeat, at) : null,
      lastHeartbeatExact: heartbeat ? exact(heartbeat) : null,
      lastRealRunAt: real,
      lastRealRunAgo: real ? agoInWords(real, at) : null,
      failingSince: failing,
      failingSinceAgo: failing ? agoInWords(failing, at) : null,
    };
  });
});

/* -------------------------------------------------------------------------- */

export interface SweepStatus {
  /** The last reconcile run that finished, cron or by hand. */
  lastAt: Date | null;
  /** "12 minutes ago", or null if Correos has never been asked. */
  ago: string | null;
  exactWhen: string | null;
  /** The last run somebody started with the Refresh button. For the guard. */
  lastManualAt: Date | null;
}

/**
 * When Correos was last asked, for the Refresh button's "Last checked …".
 *
 * A manual sweep is an ordinary `job_runs` row for the `reconcile` job with
 * `manual: true` in its detail, rather than a timestamp of its own in the
 * settings table. That is deliberate: the button and the cron are the same
 * sweep, so they belong in the same history — the Scheduled jobs panel, the
 * engine-health heartbeat and this function all see a manual run without
 * anything having to be taught about it.
 *
 * A skipped run counts here as it does everywhere else: it proves the sweep
 * reached the end, which is what "last checked" is answering.
 */
export const sweepStatus = perRequest(async (at: Date = now()): Promise<SweepStatus> => {
  const rows = await getDb().execute(raw`
    SELECT max(started_at)                                                   AS last_at,
           max(started_at) FILTER (WHERE detail->>'manual' = 'true')          AS last_manual_at
      FROM job_runs
     WHERE job = 'reconcile' AND ok IS TRUE
  `);

  const row = rowsOf<{ last_at: string | null; last_manual_at: string | null }>(rows)[0];
  const lastAt = row?.last_at ? new Date(row.last_at) : null;

  return {
    lastAt,
    ago: lastAt ? agoInWords(lastAt, at) : null,
    exactWhen: lastAt ? exact(lastAt) : null,
    lastManualAt: row?.last_manual_at ? new Date(row.last_manual_at) : null,
  };
});
