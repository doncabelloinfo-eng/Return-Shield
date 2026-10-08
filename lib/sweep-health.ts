import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import { perRequest } from '@/lib/per-request';
import { now } from '@/lib/clock';
import { madridMidnightUtc, madridParts } from '@/lib/time';
import {
  countDue, countLive, countOverdue, recheckHours, urgentRecheckHours,
} from '@/lib/recheck';
import { duration } from '@/lib/sweep-progress';
import { getSetting } from '@/lib/settings';
import { MAX_BATCH } from '@/lib/carriers/correos/trackpub';

/**
 * Is the sweep actually learning anything, how much can it get through, and
 * what is it costing?
 *
 * ALL THREE EXIST BECAUSE OF ONE DAY. Six hourly runs in a row reported "asked
 * 201, changed 0" while Correos had hundreds of events for those parcels, and
 * every screen looked perfectly healthy throughout. A fetch inside a GET route
 * handler had been cached for a year (see the note in
 * lib/carriers/correos/trackpub.ts), so the sweep was reading a file instead
 * of asking anybody.
 *
 * The fix stops it happening again. This file makes it VISIBLE if it ever
 * does — and the thing that makes that possible is `newEvents`: "changed 0" is
 * also what a quiet night looks like, so counting parcels is not enough. Zero
 * EVENTS STORED across three runs that each asked about hundreds of parcels is
 * not a quiet night.
 */

/** Below this a run is too small for its silence to mean anything. */
const BUSY_RUN_ASKED = 50;

/** Three in a row, so one odd run does not raise an alarm. */
const SILENT_RUNS_BEFORE_WARNING = 3;

export interface SweepSilence {
  /** Consecutive recent runs that asked a lot and stored nothing. */
  silentRuns: number;
  /** Parcels those runs asked about between them. */
  askedInSilence: number;
  /** True once it is worth saying out loud. */
  warn: boolean;
  /** The last run that did store something, in words. Null if none has. */
  lastEventAgo: string | null;
}

interface RunRow {
  asked: number | null;
  new_events: number | null;
  started_at: string;
}

/**
 * The last few real reconcile runs, newest first, and whether they were all
 * silent.
 *
 * Skipped runs are left out: a run that found nothing due is not a run that
 * asked and learnt nothing, and counting it would make a quiet night look like
 * an outage. A run that FAILED is also left out — it has its own alarm on the
 * same screen, and a failure is not silence.
 */
export const sweepSilence = perRequest(async (): Promise<SweepSilence> => {
  const rows = rowsOf<RunRow>(await getDb().execute(raw`
    SELECT (detail->>'asked')::int      AS asked,
           (detail->>'newEvents')::int  AS new_events,
           started_at
      FROM job_runs
     WHERE job = 'reconcile'
       AND ok IS TRUE
       AND skipped IS FALSE
     ORDER BY started_at DESC
     LIMIT 12
  `));

  let silentRuns = 0;
  let askedInSilence = 0;

  for (const row of rows) {
    const asked = row.asked ?? 0;
    const stored = row.new_events;

    /*
     * A null `newEvents` is a run from before this column existed, not a
     * silent one. Stopping the count there is deliberate: the alternative is
     * reading every pre-deploy run as silence and warning on the first day.
     */
    if (stored === null) break;
    if (asked < BUSY_RUN_ASKED) break;
    if (stored > 0) break;

    silentRuns += 1;
    askedInSilence += asked;
  }

  const withEvents = rows.find((r) => (r.new_events ?? 0) > 0);

  return {
    silentRuns,
    askedInSilence,
    warn: silentRuns >= SILENT_RUNS_BEFORE_WARNING,
    lastEventAgo: withEvents ? withEvents.started_at : null,
  };
});

/* -------------------------------------------------------------------------- */

export interface SweepCapacity {
  /** Codes per request Correos is accepting. 1 = one parcel per request. */
  batchSize: number;
  /** Why it is not larger, when something refused one. */
  batchNote: string | null;
  /** Parcels one run can get through, from what recent runs actually managed. */
  perRun: number;
  /** Whether `perRun` is measured or merely assumed. */
  measured: boolean;
  /** Live parcels the rule applies to. */
  live: number;
  /** Parcels it is time to ask about right now. */
  due: number;
  /** Parcels the promise has already been broken for. */
  overdue: number;
  recheckHours: number;
  urgentRecheckHours: number;
  /** "Asking Correos 1 parcel per request · about 420 parcels per run · …" */
  line: string;
  /** Minutes of function life the sweep has used today, in Madrid days. */
  busyMinutesToday: number;
  /** "Correos checks kept the server busy 7 minutes today" */
  costLine: string;
}

/** The budget a cron run gets, so "per run" means something. */
const RUN_BUDGET_MS = 240_000;

/**
 * What the sweep can actually get through, measured rather than assumed.
 *
 * `asked / seconds` from the runs that really happened, times the budget. The
 * measured figure on production was 201 parcels in 114 seconds — about 1.8 a
 * second at one request per parcel — which makes a 240-second run about 420
 * parcels. Nothing here derives that from a rate limit, because the rate limit
 * is a guess and the measurement is not.
 */
export const sweepCapacity = perRequest(async (at: Date = now()): Promise<SweepCapacity> => {
  const [batchSize, live, due, overdue, rate, busyMs] = await Promise.all([
    getSetting('correosBatchSize'),
    countLive(),
    countDue(at),
    countOverdue(at),
    measuredRate(),
    busyMsToday(at),
  ]);

  const effective = batchSize > 0 ? batchSize : MAX_BATCH;
  const perRun = Math.max(1, Math.round((rate.perSecond ?? 1.8) * (RUN_BUDGET_MS / 1000)));
  const busyMinutesToday = Math.round(busyMs / 60_000);

  const parts: string[] = [];
  parts.push(`Asking Correos ${effective === 1 ? '1 parcel' : `${effective} parcels`} per request`
    + (rate.batchNote ? ` (${rate.batchNote})` : ''));
  parts.push(`about ${perRun.toLocaleString('en-GB')} parcels per run`
    + (rate.measured ? '' : ' (estimated — no run has finished yet)'));
  parts.push(`${live.toLocaleString('en-GB')} live`);
  parts.push(overdue > 0
    ? `${overdue.toLocaleString('en-GB')} overdue`
    : `every parcel checked in the last ${recheckHours()} hours`);

  return {
    batchSize: effective,
    batchNote: rate.batchNote,
    perRun,
    measured: rate.measured,
    live,
    due,
    overdue,
    recheckHours: recheckHours(),
    urgentRecheckHours: urgentRecheckHours(),
    line: parts.join(' · '),
    busyMinutesToday,
    costLine: busyMs > 0
      ? `Correos checks kept the server busy ${duration(Math.round(busyMs / 1000))} today`
      : 'Correos checks have not run yet today',
  };
});

/**
 * Parcels per second, from the runs that actually happened.
 *
 * Only runs that asked about a meaningful number: a run that asked about two
 * parcels in forty milliseconds would say fifty a second, and a run that asked
 * about none would divide by zero.
 */
async function measuredRate(): Promise<{
  perSecond: number | null; measured: boolean; batchNote: string | null;
}> {
  const rows = rowsOf<{ asked: number | null; took_ms: number | null; note: string | null }>(
    await getDb().execute(raw`
      SELECT (detail->>'asked')::int    AS asked,
             (detail->>'tookMs')::int   AS took_ms,
             detail->>'batchNote'       AS note
        FROM job_runs
       WHERE job = 'reconcile' AND ok IS TRUE AND skipped IS FALSE
         AND (detail->>'asked')::int >= 20
       ORDER BY started_at DESC
       LIMIT 5
    `),
  );

  const note = rows.find((r) => r.note)?.note ?? null;
  const usable = rows.filter((r) => (r.asked ?? 0) > 0 && (r.took_ms ?? 0) > 0);
  if (!usable.length) return { perSecond: null, measured: false, batchNote: note };

  const perSecond = usable.reduce((sum, r) => sum + (r.asked! / (r.took_ms! / 1000)), 0)
    / usable.length;

  return { perSecond, measured: true, batchNote: note };
}

/**
 * How long reconcile runs have been alive today, in Madrid days.
 *
 * This is the cost driver, and the reason it is worth a line on the screen:
 * Vercel bills memory for the whole time a function is alive and CPU only
 * while code is running. The sweep spends nearly all of its life waiting on
 * Correos, so what it costs is wall-clock — not work done.
 *
 * `finished_at - started_at`, which is exactly what is billed. A run still in
 * flight has no `finished_at` and is left out rather than counted as zero.
 */
async function busyMsToday(at: Date): Promise<number> {
  const p = madridParts(at);
  const midnight = madridMidnightUtc(p.year, p.month, p.day);

  const rows = rowsOf<{ ms: number | null }>(await getDb().execute(raw`
    SELECT COALESCE(
             sum(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000),
             0
           )::bigint AS ms
      FROM job_runs
     WHERE job = 'reconcile'
       AND started_at >= ${ts(midnight)}
       AND finished_at IS NOT NULL
  `));

  return Number(rows[0]?.ms ?? 0);
}
