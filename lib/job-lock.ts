import { randomUUID } from 'node:crypto';
import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import type { JobName } from '@/jobs/definitions';

/**
 * A lease, so two cron invocations of the same job do not both do the work.
 *
 * Vercel Cron is best-effort: a run is never retried, the same run can fire
 * twice, and two runs can overlap. The usual answer is a session advisory lock,
 * and it is not available to us — Supabase's transaction pooler multiplexes
 * connections, so `pg_try_advisory_lock` would be taken on one backend and the
 * next statement would run on another. Nothing session-scoped survives.
 *
 * So: a row with an expiry, taken in one statement.
 *
 * Two details carry most of the weight.
 *
 * The lease is computed by the DATABASE. Every instant here is SQL `now()`,
 * never `lib/clock.ts`. The app clock is injectable and demo mode moves it by
 * days; a lease computed from it would land a fortnight in the future and the
 * job would be unrunnable until somebody hand-edited the row. The database's
 * clock is also the only one every instance agrees on.
 *
 * And the release is fenced. An instance frozen past its lease — which is
 * exactly what serverless does — must not wake up and release a lock a later
 * run legitimately holds. That would re-create the double-run this exists to
 * prevent. So release matches on the token as well as the job.
 */

export interface Lease {
  job: JobName;
  /** The fencing token this holder was given. */
  token: string;
}

export type AcquireResult =
  | { acquired: true; lease: Lease }
  | { acquired: false; heldUntil: Date | null };

/**
 * Take the lock, or report that somebody else has it.
 *
 * One statement, and it does three things at once: creates the row the first
 * time, takes the lease if it is free, and returns nothing at all if it is not.
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE job_locks.locked_until <= now()` is the
 * whole trick. At READ COMMITTED a second writer arriving concurrently blocks
 * on the row until the first commits, then re-evaluates the WHERE against the
 * committed row and matches nothing. No retry loop, no race.
 *
 * Rows are deliberately NOT seeded by the migration. The test helper truncates
 * every table between files, so seeded rows would vanish and every job would
 * look permanently locked under test; and a job added later without a matching
 * seed row would never run again — a silent failure, which is worse than the
 * double-run.
 */
export async function acquireJobLock(job: JobName, leaseSeconds: number): Promise<AcquireResult> {
  const token = randomUUID();
  const seconds = Math.max(5, Math.round(leaseSeconds));

  const rows = await getDb().execute<{ locked_until: string }>(raw`
    INSERT INTO job_locks (job, locked_until, locked_by, acquired_at)
    VALUES (${job}, now() + make_interval(secs => ${seconds}), ${token}, now())
    ON CONFLICT (job) DO UPDATE
      SET locked_until = now() + make_interval(secs => ${seconds}),
          locked_by = ${token},
          acquired_at = now()
      WHERE job_locks.locked_until <= now()
    RETURNING locked_until
  `);

  const row = rowsOf<{ locked_until: string }>(rows)[0];
  if (row) return { acquired: true, lease: { job, token } };

  // Somebody else holds it. Worth knowing until when, so the skip can say so.
  const held = await getDb().execute<{ locked_until: string }>(raw`
    SELECT locked_until FROM job_locks WHERE job = ${job}
  `);
  const until = rowsOf<{ locked_until: string }>(held)[0]?.locked_until;
  return { acquired: false, heldUntil: until ? new Date(until) : null };
}

/**
 * Give the lock back.
 *
 * Without this a job that runs for three seconds would hold a ninety-second
 * lease and the next tick would skip. The token is what makes it safe: a stale
 * holder's release matches no rows rather than freeing somebody else's lock.
 */
export async function releaseJobLock(lease: Lease): Promise<void> {
  await getDb().execute(raw`
    UPDATE job_locks
       SET locked_until = now() - make_interval(secs => 1),
           locked_by = NULL
     WHERE job = ${lease.job}
       AND locked_by = ${lease.token}
  `);
}

/**
 * How long a lease should last: the route's own ceiling plus a little grace.
 *
 * Shorter than the route's `maxDuration` and the lease expires while the first
 * run is still working, letting a second one in — precisely the failure the
 * lock exists to stop. Much longer and a killed instance wedges the job for
 * minutes. Derived from the route rather than written down twice, so raising a
 * route's maxDuration to fix a timeout cannot silently start letting doubles
 * through on the job that was already too slow.
 */
export function leaseSecondsFor(maxDurationSeconds: number): number {
  return maxDurationSeconds + 30;
}
