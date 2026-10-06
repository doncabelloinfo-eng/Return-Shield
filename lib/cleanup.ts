import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { now } from '@/lib/clock';
import { madridMidnightUtc, madridParts } from '@/lib/time';
import { retentionDays, retentionWasClamped, MIN_RETENTION_DAYS } from '@/lib/retention';

/**
 * The rolling window. Every night, the day that has just become the
 * thirty-first day back is deleted.
 *
 * Never a sweep that wipes everything older than X all at once. The job is
 * identical on its first night and its thousandth, which means a mistake costs
 * one day rather than the archive — and it means the first night after this
 * ships is not the night a bug deletes a year.
 *
 * TWO THINGS ARE DELIBERATELY KEPT.
 *
 * An unfinished parcel past the window stays until it finishes. A parcel still
 * moving at thirty-one days is precisely the one that needs a human, and
 * deleting it would also stop its tracking — the reconcile sweep reads
 * `shipments`, so a deleted parcel is a parcel nobody is asking Correos about.
 * The Parcels screen has a tab for them and the digest counts them, because
 * keeping them silently is only half the job.
 *
 * And `closures` is never touched. It is the one record meant to outlive its
 * parcel; see db/schema.ts.
 */

/** Rows per statement. Small enough to stay inside a statement timeout. */
export const BATCH = 5000;

export interface CleanupReport {
  windowDays: number;
  /** Madrid midnight at the start of the oldest day still kept. */
  keepFrom: string;
  orders: number;
  activity: number;
  reviewQueue: number;
  pushInbox: number;
  alerts: number;
  importBatches: number;
  jobRuns: number;
  postcodes: number;
  /** Past the window, still going, kept on purpose. */
  keptUnfinished: number;
  /** Set when RETENTION_DAYS asked for less than the floor allows. */
  note?: string;
}

/**
 * The cutoff: Madrid midnight at the start of the oldest day we keep.
 *
 * A calendar-day boundary rather than "now minus 30 × 86,400,000". Subtracting
 * milliseconds makes the cutoff drift through the day, so a run at 03:15 and a
 * run at 03:20 disagree about whether a parcel from the edge of the window is
 * in or out — and on the night the clocks change they disagree by an hour.
 * Whole Madrid days mean the window has the same edge all night.
 */
export function cutoffFor(at: Date, days = retentionDays()): Date {
  const p = madridParts(at);
  return madridMidnightUtc(p.year, p.month, p.day - days);
}

/**
 * Delete in batches until there is nothing left, and say how many went.
 *
 * `LIMIT` inside a subselect because `DELETE … LIMIT` is not valid Postgres.
 * The loop has a hard ceiling: a `while` with no bound is one bad predicate
 * away from a job that never ends and a lock nobody can clear.
 */
async function deleteBatched(
  what: string,
  sqlFor: (limit: number) => ReturnType<typeof raw>,
  maxBatches = 200,
): Promise<number> {
  let total = 0;

  for (let i = 0; i < maxBatches; i += 1) {
    const result = await getDb().execute(sqlFor(BATCH));
    const went = rowsOf<{ id: unknown }>(result).length;
    total += went;
    if (went < BATCH) return total;
  }

  // A million rows in one night means something else is wrong; finish the rest
  // tomorrow rather than holding locks until the function is killed.
  return total;
}

export async function runCleanup(at: Date = now()): Promise<CleanupReport> {
  const windowDays = retentionDays();
  const keepFrom = cutoffFor(at, windowDays);
  const iso = keepFrom.toISOString();

  /*
   * Orders first, because the cascade does most of the work: shipments,
   * shipment_events, tasks, contact_log, notifications, shipment_actions and
   * the escalation rows all hang off an order by ON DELETE CASCADE.
   *
   * The condition has two halves and both matter. The order came in before the
   * window, AND none of its shipments is still going — finished being
   * delivered, collected, returned, or closed by hand, which is the same
   * definition the Parcels screen uses.
   */
  const orders = await deleteBatched('orders', (limit) => raw`
    DELETE FROM orders
     WHERE id IN (
       SELECT o.id FROM orders o
        WHERE o.created_at < ${iso}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM shipments s
             WHERE s.order_id = o.id
               AND s.dropped_at IS NULL
               AND s.state NOT IN ('delivered', 'collected', 'returned')
          )
        LIMIT ${limit}
     )
    RETURNING id
  `);

  const activity = await deleteBatched('activity', (limit) => raw`
    DELETE FROM activity WHERE id IN (
      SELECT id FROM activity WHERE at < ${iso}::timestamptz LIMIT ${limit}
    ) RETURNING id
  `);

  // Only the resolved ones. An unresolved row is a Correos wording nobody has
  // mapped yet, and that is a to-do list, not a log.
  const reviewQueue = await deleteBatched('event_review_queue', (limit) => raw`
    DELETE FROM event_review_queue WHERE id IN (
      SELECT id FROM event_review_queue
       WHERE resolved_at IS NOT NULL AND resolved_at < ${iso}::timestamptz
       LIMIT ${limit}
    ) RETURNING id
  `);

  const pushInbox = await deleteBatched('correos_push_inbox', (limit) => raw`
    DELETE FROM correos_push_inbox WHERE id IN (
      SELECT id FROM correos_push_inbox
       WHERE processed_at IS NOT NULL AND received_at < ${iso}::timestamptz
       LIMIT ${limit}
    ) RETURNING id
  `);

  // Delivered only: an alert still sitting unsent is unfinished business.
  const alerts = await deleteBatched('alerts', (limit) => raw`
    DELETE FROM alerts WHERE id IN (
      SELECT id FROM alerts
       WHERE sent_at IS NOT NULL AND created_at < ${iso}::timestamptz
       LIMIT ${limit}
    ) RETURNING id
  `);

  const importBatches = await deleteBatched('import_batches', (limit) => raw`
    DELETE FROM import_batches WHERE id IN (
      SELECT id FROM import_batches WHERE created_at < ${iso}::timestamptz LIMIT ${limit}
    ) RETURNING id
  `);

  const jobRuns = await deleteBatched('job_runs', (limit) => raw`
    DELETE FROM job_runs WHERE id IN (
      SELECT id FROM job_runs WHERE started_at < ${iso}::timestamptz LIMIT ${limit}
    ) RETURNING id
  `);

  /*
   * Postcodes with nothing left in the window.
   *
   * The nightly rebuild reads `shipments`, so it was already a rolling window
   * without anybody deciding that — but it only ever upserts, so a postcode
   * whose last parcel aged out kept its old failure rate for ever and could
   * stay flagged on the Settings screen with no parcels behind it. This makes
   * the window explicit.
   */
  const postcodes = await deleteBatched('postcode_stats', (limit) => raw`
    DELETE FROM postcode_stats WHERE postal_code IN (
      SELECT ps.postal_code FROM postcode_stats ps
       WHERE NOT EXISTS (
         SELECT 1 FROM orders o WHERE o.postal_code = ps.postal_code
       )
       LIMIT ${limit}
    ) RETURNING postal_code AS id
  `);

  const keptUnfinished = await countKeptUnfinished(keepFrom);

  return {
    windowDays,
    keepFrom: iso,
    orders,
    activity,
    reviewQueue,
    pushInbox,
    alerts,
    importBatches,
    jobRuns,
    postcodes,
    keptUnfinished,
    ...(retentionWasClamped()
      ? { note: `RETENTION_DAYS asked for less than ${MIN_RETENTION_DAYS}; using ${windowDays}` }
      : {}),
  };
}

/** Orders past the window whose parcels are still going. Kept, and counted. */
export async function countKeptUnfinished(keepFrom: Date): Promise<number> {
  const result = await getDb().execute(raw`
    SELECT count(*)::int AS n
      FROM shipments s
      JOIN orders o ON o.id = s.order_id
     WHERE o.created_at < ${keepFrom.toISOString()}::timestamptz
       AND s.dropped_at IS NULL
       AND s.state NOT IN ('delivered', 'collected', 'returned')
  `);
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
}

/** What the database weighs, for the Settings screen. */
export async function databaseBytes(): Promise<number> {
  const result = await getDb().execute(raw`
    SELECT pg_database_size(current_database())::bigint AS bytes
  `);
  const row = rowsOf<{ bytes: string | number }>(result)[0];
  return row ? Number(row.bytes) : 0;
}
