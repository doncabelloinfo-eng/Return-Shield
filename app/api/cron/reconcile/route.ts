import { cronRoute } from '@/lib/cron';
import { reconcile } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The sweep is the only thing that ever repairs a push Correos dropped, and
 * pushes are not retried — so it runs every two hours rather than nightly,
 * which cuts the worst-case staleness of a countdown from a day to two hours.
 *
 * It is bounded twice over: at most `batchSize` parcels, and it stops starting
 * new lookups after `budgetMs`. Both sit well inside maxDuration, so the run
 * always ends by choice rather than by being killed half way through a sweep.
 */
export const maxDuration = 60;

const BUDGET_MS = 45_000;

export const GET = cronRoute('nightly-reconcile', () => reconcile({ budgetMs: BUDGET_MS }));
