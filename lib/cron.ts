import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runJob, type JobName, type JobResult } from '@/jobs/definitions';
import { loadDemoClock } from '@/lib/demo-clock';
import { madridParts } from '@/lib/time';
import { now } from '@/lib/clock';
import { closeDb } from '@/db';

/**
 * Every scheduled job is an HTTP route on Vercel, so every scheduled job is
 * also a public URL. These are the two things that makes safe.
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
   * Only do the work when it is this hour in Madrid.
   *
   * Vercel schedules in UTC, and Madrid is UTC+1 or UTC+2 depending on the time
   * of year — so a fixed UTC schedule drifts by an hour twice a year. For the
   * jobs where the hour is the point (nobody wants the morning digest at seven,
   * and a "no update" sweep before the day starts is noise), the schedule fires
   * at both candidate UTC hours and this check decides which one is real.
   */
  onlyAtMadridHour?: number;
}

/**
 * Wraps a job as a route handler. The job function is unchanged — this is
 * wiring, not logic.
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

    await loadDemoClock();

    if (options.onlyAtMadridHour !== undefined) {
      const hour = madridParts(now()).hour;
      if (hour !== options.onlyAtMadridHour) {
        // The other half of the pair of UTC schedules. Not an error — exactly
        // one of the two is the right one on any given day.
        return NextResponse.json({
          job: name,
          skipped: `it is ${hour}:00 in Madrid, this job runs at ${options.onlyAtMadridHour}:00`,
        });
      }
    }

    let detail: Record<string, unknown> = {};
    await runJob(name, async () => {
      const result = await job();
      detail = result.detail;
      return result;
    });

    // Serverless instances are frozen between invocations. Handing the
    // connections back keeps a once-a-minute job from sitting on a pool.
    await closeDb().catch(() => {});

    return NextResponse.json({ job: name, detail });
  };
}
