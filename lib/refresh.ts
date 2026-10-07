import { MINUTE } from '@/lib/clock';
import { envNumber } from '@/lib/env';
import { leaseSecondsFor } from '@/lib/job-lock';

/**
 * Everything the manual Correos sweep needs that is not itself a server action.
 *
 * THIS FILE EXISTS BECAUSE OF A CRASH, AND THE CRASH IS WORTH WRITING DOWN.
 *
 * `MANUAL_SWEEP_GAP_MS` used to be exported from `app/actions/refresh.ts`,
 * which carries `'use server'`. Next refuses to load such a module at all if it
 * exports anything but an async function:
 *
 *     Error: A "use server" file can only export async functions, found number.
 *
 * Not the one export — the whole module. So every action in the file went down
 * with it: the Refresh button, the Correos check after an upload, and the
 * Correos check after a thirty-day pull, each answering 500 with
 * "Application error: a server-side exception has occurred".
 *
 * And nothing caught it, because every test imported the actions directly.
 * Vitest loads the file as an ordinary module; the rule is Next's, applied by
 * its compiler, and only a real build or a real request meets it. Hence
 * `tests/use-server-exports.test.ts`, which reads the files rather than
 * importing them.
 *
 * The rule to keep: a `'use server'` file holds async functions and types, and
 * nothing else. Constants, helpers and pure functions live here, where they can
 * also be unit-tested without a request.
 */

/**
 * At most one manual sweep every five minutes.
 *
 * A courtesy rather than a correctness rule — the `job_locks` row is what stops
 * two sweeps overlapping. This stops twenty presses in a minute spending the
 * Correos quota on parcels that were up to date thirty seconds ago.
 */
export const MANUAL_SWEEP_GAP_MS = 5 * MINUTE;

/**
 * How long a sweep started by hand may run for, and how long its lease lasts.
 *
 * The budget sits inside the function limit so the sweep ends by choice rather
 * than by being killed half way through, and the lease is longer still so a
 * cron tick cannot start while this one is working. Both derived from one
 * number, the same way the cron routes derive theirs from `maxDuration` —
 * raising one without the other is how a job that was already too slow starts
 * letting doubles through.
 */
export function manualSweepBudgetMs(): number {
  return envNumber('MANUAL_SWEEP_BUDGET_MS', 240_000);
}

export function manualSweepLeaseSeconds(): number {
  return leaseSecondsFor(manualSweepBudgetMs() / 1000);
}

/**
 * The line the Refresh button shows:
 * "Checked 412 parcels with Correos · 7 changed · 1,200 still to check …"
 *
 * `changed` counts PARCELS rather than events — a parcel whose whole history
 * arrived in one go changed once, not eleven times. See `reconcile`.
 */
export function sweepResultLine(detail: Record<string, unknown>): string {
  const asked = num(detail.asked);
  const changed = num(detail.changed);
  const left = num(detail.stillToCheck);

  const parts = [
    `Checked ${asked.toLocaleString('en-GB')} ${asked === 1 ? 'parcel' : 'parcels'} with Correos`,
    `${changed.toLocaleString('en-GB')} changed`,
  ];

  // Only when the sweep genuinely ran out of time. Those parcels lead the
  // queue on the next press or the next cron run, because the ordering IS the
  // cursor — see `reconcile`.
  if (left > 0 && detail.stoppedEarly) {
    parts.push(`${left.toLocaleString('en-GB')} still to check — they go first next time`);
  }

  return parts.join(' · ');
}

/**
 * Job detail arrives as `Record<string, unknown>` and the counts come back
 * from Postgres as strings often enough to matter — `count(*)` is a bigint.
 */
function num(x: unknown): number {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}
