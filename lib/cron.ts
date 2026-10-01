import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import { getDb, closeDb } from '@/db';
import { jobRuns } from '@/db/schema';
import { runJob, type JobName, type JobResult } from '@/jobs/definitions';
import { acquireJobLock, releaseJobLock, leaseSecondsFor, type Lease } from '@/lib/job-lock';
import { loadDemoClock } from '@/lib/demo-clock';
import { madridMidnightUtc, madridParts } from '@/lib/time';
import { now } from '@/lib/clock';

/**
 * Every scheduled job is an HTTP route on Vercel, so every scheduled job is
 * also a public URL that anyone can hit as often as they like. And Vercel Cron
 * is best-effort: it never retries, it can fire the same run twice, and two
 * runs can overlap.
 *
 * This file is what makes that safe:
 *   · a bearer token, so only Vercel can start a job;
 *   · a lease, so two invocations do not both do the work;
 *   · catch-up, so a daily job that was dropped still runs today;
 *   · an honest HTTP status, so a failure does not read as green in the log.
 */

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron invocation.
 * Nothing without it gets through — and if CRON_SECRET is not configured,
 * nothing gets through at all, because an open endpoint that sweeps the whole
 * shipment table and emails the team is worse than a job that never runs.
 */
export function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token !== '' && equal(token, secret);
}

export interface CronOptions {
  /**
   * This job runs once a Madrid day, at or after this hour.
   *
   * It replaces an earlier scheme where the job fired at both candidate UTC
   * hours and did nothing unless the Madrid hour matched exactly. That was
   * correct and fragile: Vercel does not retry, so a single dropped
   * invocation meant the digest never went out and nothing said so.
   *
   * Now the job is scheduled hourly and asks two questions: is it past the
   * hour in Madrid, and has a real run already happened today? The schedule
   * being dropped once costs an hour instead of a day.
   */
  dailyAfterMadridHour?: number;

  /**
   * Seconds the lease should last. Defaults to the route's maxDuration plus
   * grace, which is what every caller should want — pass it the same number
   * the route declares.
   */
  maxDurationSeconds?: number;
}

/**
 * Has a real run of this job finished successfully today, in Madrid days?
 *
 * Three decisions, each of which is wrong in an obvious-looking way:
 *
 * `ok` must be exactly true. A `job_runs` row has three states, not two: an
 * instance killed mid-run leaves `ok` null for ever, because the catch block
 * never executed. Counting null as done loses the day.
 *
 * `skipped` must be false. A skip is a successful run with no work — it proves
 * the scheduler is alive, which is what the engine-health banner wants, but it
 * is not "today's digest has been sent".
 *
 * The range is bounded at BOTH ends, which looks unnecessary because nothing
 * is in the future. Demo mode puts things in the future: it stamps
 * `started_at` from an offset app clock, and when the offset is reset those
 * rows remain dated days ahead. An open-ended `>= midnight` would read them as
 * "today is done" and suppress the job until the calendar caught up.
 *
 * The boundary uses the injectable clock rather than SQL `now()`, which is the
 * opposite of the lock's choice and deliberately so: `started_at` is written
 * from the injectable clock, so comparing it against the database's would make
 * the two disagree the moment the demo clock moves.
 */
export async function ranToday(job: JobName, at: Date = now()): Promise<boolean> {
  const p = madridParts(at);
  const from = madridMidnightUtc(p.year, p.month, p.day);
  const until = madridMidnightUtc(p.year, p.month, p.day + 1);

  const rows = await getDb().select({ id: jobRuns.id }).from(jobRuns)
    .where(and(
      eq(jobRuns.job, job),
      eq(jobRuns.ok, true),
      eq(jobRuns.skipped, false),
      gte(jobRuns.startedAt, from),
      lt(jobRuns.startedAt, until),
    ))
    .limit(1);

  return rows.length > 0;
}

/**
 * Wraps a job as a route handler. The job function itself is unchanged — this
 * is wiring, not logic.
 */
export function cronRoute(
  name: JobName,
  job: () => Promise<JobResult>,
  options: CronOptions = {},
) {
  return async function GET(req: Request): Promise<NextResponse> {
    if (!authorised(req)) {
      return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { error: 'DATABASE_URL is not set, so there is nothing to run against' },
        { status: 503 },
      );
    }

    let lease: Lease | null = null;

    try {
      await loadDemoClock();

      // The lock comes FIRST, before the catch-up check, and the order is not
      // interchangeable. `runJob` records success only on completion, so
      // "has today's run happened" reads false for the whole time a run is in
      // flight. Checking it outside the lock is a race: read false, the other
      // run commits and releases, this one takes a now-free lock and sends a
      // second digest.
      const lock = await acquireJobLock(
        name,
        leaseSecondsFor(options.maxDurationSeconds ?? 60),
      );

      if (!lock.acquired) {
        // Not an error. Vercel duplicates ticks routinely, and a 500 here would
        // make the lock itself look like an outage.
        await recordSkip(name, {
          skipped: 'locked',
          heldUntil: lock.heldUntil?.toISOString() ?? null,
        });
        return NextResponse.json({ job: name, skipped: 'locked' });
      }
      lease = lock.lease;

      if (options.dailyAfterMadridHour !== undefined) {
        const hour = madridParts(now()).hour;

        if (hour < options.dailyAfterMadridHour) {
          await recordSkip(name, {
            skipped: 'too early',
            note: `it is ${hour}:00 in Madrid, this job runs from ${options.dailyAfterMadridHour}:00`,
          });
          return NextResponse.json({ job: name, skipped: 'too early' });
        }

        if (await ranToday(name)) {
          await recordSkip(name, { skipped: 'already done today' });
          return NextResponse.json({ job: name, skipped: 'already done today' });
        }
      }

      const outcome = await runJob(name, job);

      // A job that threw used to return 200 with an empty detail, so Vercel's
      // cron log showed green on the day it failed. Vercel does not retry on
      // 500, so this changes nothing about the schedule — it is purely about
      // the log telling the truth.
      return NextResponse.json(
        { job: name, ok: outcome.ok, skipped: outcome.skipped, detail: outcome.detail },
        { status: outcome.ok ? 200 : 500 },
      );
    } finally {
      // Release before closing the pool: there is no connection to release
      // through afterwards, the error would be swallowed, and the job would be
      // wedged for the whole lease.
      try {
        if (lease) await releaseJobLock(lease);
      } catch {
        // Left to expire. The lease is the backstop for exactly this.
      }
      // Serverless instances are frozen between invocations. Handing the
      // connections back keeps a job that runs every few minutes from sitting
      // on a pool — and this has to happen on every path, including the
      // skipped ones, which is where it used to leak.
      await closeDb().catch(() => {});
    }
  };
}

/**
 * Write down that a run happened and chose to do nothing.
 *
 * Without this a locked or already-done invocation leaves no trace, and the
 * operator cannot tell "the scheduler fired and correctly did nothing" from
 * "the scheduler never fired" — which is the exact question the engine-health
 * banner exists to answer.
 */
async function recordSkip(job: JobName, detail: Record<string, unknown>): Promise<void> {
  await runJob(job, async () => ({ detail, skipped: true }));
}
