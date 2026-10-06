import { env } from '@/lib/env';

/**
 * How long this system remembers.
 *
 * The database is on Supabase's free plan: 500 MB, 13 MB used today. One
 * `shipment_events` row carries about 550 bytes of raw Correos payload, and at
 * a thousand parcels a day with a handful of events each that is roughly a
 * gigabyte a year. Nothing deleted anything, so the only question was when it
 * would stop rather than whether.
 *
 * So the system holds a rolling thirty days and the nightly job drops the day
 * that has just fallen off the end. Never a sweep that wipes everything at
 * once: one day at a time means a mistake costs one day, and the job is
 * identical on its first night and its thousandth.
 *
 * WHAT IS NEVER DELETED: users, stores, settings, product_rules, offices,
 * postcode_stats — all configuration — and `closures`, which is the permanent
 * record of every parcel written off. See db/schema.ts.
 */

/** Below this, the window stops being a window and starts being a shredder. */
export const MIN_RETENTION_DAYS = 14;
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * The window, in days.
 *
 * `RETENTION_DAYS` can raise it or lower it, but never below fourteen. The
 * floor is not arbitrary: the escalation ladder runs over a fifteen-day
 * deposit window, so a shorter retention would delete parcels that are still
 * being chased, and the chasing would stop with no trace of why. An
 * environment variable should not be able to do that.
 *
 * A NUMBER BELOW THE FLOOR IS CLAMPED; SOMETHING THAT IS NOT A NUMBER FALLS
 * BACK TO THIRTY. The distinction is the whole reason this does not just call
 * `envNumber`: that helper treats 0 and -5 as unusable and hands back the
 * default, so `RETENTION_DAYS=13` became 14 while `RETENTION_DAYS=0` became
 * 30 — the same mistake answered two different ways, and `retentionWasClamped`
 * reported one of them as fine.
 *
 * `0` is somebody asking us to delete everything. The answer is the floor, and
 * it is the same answer `13` gets, with the same note in the job detail.
 */
function asked(): number | null {
  const raw = env('RETENTION_DAYS');
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function retentionDays(): number {
  const want = asked();
  if (want === null) return DEFAULT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.floor(want));
}

/** True when `RETENTION_DAYS` asked for something the floor refused. */
export function retentionWasClamped(): boolean {
  const want = asked();
  return want !== null && want < MIN_RETENTION_DAYS;
}

/** Supabase's free plan. The number the Settings screen measures against. */
export const FREE_PLAN_BYTES = 500 * 1024 * 1024;
/** Loud enough to act on while there is still room to act. */
export const DB_WARN_BYTES = 400 * 1024 * 1024;
