import { cronRoute } from '@/lib/cron';
import { reconcile } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Push is not configured, so this is not a safety net — it is the only way
 * tracking reaches the system. About a thousand parcels a day are shipped, so
 * roughly five thousand are live at once and every one must be refreshed at
 * least every twelve hours. Every three hours with batches of a hundred is
 * about fifty requests a run, which clears the whole live set eight times a
 * day with room to spare.
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
  () => reconcile({ budgetMs: BUDGET_MS }),
  { maxDurationSeconds: maxDuration },
);
