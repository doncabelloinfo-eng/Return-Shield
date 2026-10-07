import { sql as raw, type SQL } from 'drizzle-orm';

/**
 * The day a parcel was handed to Correos, and the one date the retention
 * window is allowed to measure from.
 *
 * It is a column rather than something derived at read time because the three
 * sources disagree about how good they are:
 *
 *   1. The Shopify fulfilment's `created_at`, or a marketplace file's
 *      `ship-date`. These are the real thing.
 *   2. The Prerregistrado event (`A090000V`) — Correos' own first sighting,
 *      usually within hours of the label being printed.
 *   3. When we first saw the row, which is a guess, and a bad one after a
 *      backfill: a thirty-day pull writes every order with today's date.
 *
 * (3) is why this is not `orders.created_at`. A window counted from that would
 * keep a parcel posted five weeks ago for another thirty days, and the first
 * pull would hold the whole month twice over before settling down.
 */

/**
 * The effective ship date, in SQL: the column when it is set, the row's own
 * creation when it is not.
 *
 * One fragment, used by the retention sweep, the "Stuck 30+ days" tab and the
 * date filter, so the three cannot disagree about which parcels are old. A
 * parcel in the tab that the cleanup will not delete, or the other way round,
 * is the kind of inconsistency nobody reports and everybody stops trusting.
 */
export function shippedAtSql(table = 's'): SQL {
  return raw`COALESCE(${raw.raw(table)}.shipped_at, ${raw.raw(table)}.created_at)`;
}

/** The same chain, for a row already in hand. */
export function effectiveShipDate(
  row: { shippedAt: Date | null; createdAt: Date },
): Date {
  return row.shippedAt ?? row.createdAt;
}
