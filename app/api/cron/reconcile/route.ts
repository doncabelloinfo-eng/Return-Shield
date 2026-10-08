import { cronRoute } from '@/lib/cron';
import { reconcile } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/*
 * `fetchCache = 'force-no-store'` is the second half of the fix for the day
 * tracking silently stopped: it makes every fetch in this route uncacheable
 * whether or not the call site remembers to say so. `dynamic` governs
 * rendering and did not prevent it. See lib/carriers/correos/trackpub.ts.
 */
export const fetchCache = 'force-no-store';

/**
 * Push is not configured, so this is not a safety net — it is the only way
 * tracking reaches the system.
 *
 * EVERY HOUR, DOING ONLY WHAT IS DUE. It used to run every three hours and ask
 * about every live parcel: at 201 parcels and one request each that was 114
 * seconds of a function being alive, to learn that 190 of them had not moved.
 * Vercel bills memory for the whole time a function is alive and CPU only
 * while code is running, and this sweep spends nearly all of its life waiting
 * on Correos — so the bill is wall-clock, and the way to cut it is to ask
 * about fewer parcels more often.
 *
 * The rule it enforces is in lib/recheck.ts: every live parcel at least every
 * twelve hours, and every three for the four states where being out of date
 * costs something. Running hourly is what makes a three-hour promise keepable
 * at all — on a three-hourly schedule, one dropped invocation breaks it.
 *
 * Bounded twice over: at most RECONCILE_BATCH_SIZE parcels, and no new request
 * started after the budget. The budget sits well inside maxDuration so the run
 * always ends by choice rather than by being killed half way through a sweep —
 * and the lease is longer still, so a second invocation cannot start while
 * this one is working.
 */
export const maxDuration = 300;

const BUDGET_MS = 240_000;

export const GET = cronRoute(
  'reconcile',
  // `dueOnly`: only the parcels the twelve-hour rule says are due, which is
  // what lets this run every hour for less money than three-hourly cost. Most
  // hours that is a handful or none, and a run with nothing due ends in
  // milliseconds without a token or a request. See lib/recheck.ts.
  () => reconcile({ budgetMs: BUDGET_MS, dueOnly: true }),
  { maxDurationSeconds: maxDuration },
);
