import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, retryableRead, rowsOf, at as ts } from '@/db';
import { now, DAY } from '@/lib/clock';
import { stateLabels, type Bilingual } from '@/lib/carriers/correos/state-map';
import { MATCH_COLUMNS, matchLateral, resolveMatch, type MatchColumns } from '@/lib/scan/match';
import { scanLabel, type ScanLabel } from '@/lib/scan/items';
import { SCAN_RETENTION_DAYS } from '@/lib/scan/model';
import { scanMark, type ScanMark } from './scans';

/**
 * Returns: every parcel the warehouse scanned coming back, newest first.
 *
 * This is the half of the Scanner the office reads. A return arriving is the
 * one event Correos is slowest to report and the warehouse knows about first —
 * the box is physically on the bench — so until now a parcel could be back in
 * the building for a week with nothing in Return Shield saying so.
 *
 * TWO SECTIONS, AND THE SECOND IS NOT A FAULT. "Not in Return Shield" is
 * returns from before this system existed, and parcels whose order the rolling
 * thirty-day window removed before the return arrived. Both are real parcels
 * somebody has to deal with, and a screen that showed only the matched ones
 * would quietly hide them.
 *
 * A MATCHED RETURN STAYS MATCHED. The order number and shop were copied onto
 * the scan when it was taken (lib/scan/batches.ts), so a parcel the cleanup
 * removes on day 31 does not make its return jump sections — it keeps its
 * order number and says the parcel itself has gone.
 */

/** The newest N per section. The counts above them are exact. */
export const RETURNS_LIMIT = 100;

export interface ReturnRow {
  /** The scan's id. Stable, so React has a key that is not the code. */
  id: string;
  /** The 15-character base, which is what somebody reads off the box. */
  base: string;
  postalCode: string | null;
  /** When it came back, and who scanned it. */
  back: ScanMark;
  /** When it left, if the warehouse ever scanned it out. */
  left: ScanMark | null;
  /** The order and shop, from the live match or from the copy on the scan. */
  label: ScanLabel | null;
  /** Correos' word for it now, or null when the parcel has gone. */
  status: Bilingual | null;
  /** The parcel page, while the parcel exists. */
  shipmentId: string | null;
  /** True when the parcel was matched once and has since been cleaned up. */
  parcelGone: boolean;
}

export interface ReturnsView {
  /** Matched to a parcel, now or when it was scanned. */
  mine: ReturnRow[];
  /** Nothing matched: before Return Shield, or cleaned up before it came back. */
  theirs: ReturnRow[];
  mineTotal: number;
  theirsTotal: number;
  /** What the search box holds. */
  q: string;
  /** How far back this goes. */
  days: number;
}

interface ReturnRaw extends MatchColumns {
  id: string;
  base: string;
  code_as_read: string;
  postal_code: string | null;
  scanned_at: string;
  worker: string;
  copied_order: string | null;
  copied_store: string | null;
  state: string | null;
  out_at: string | null;
  out_by: string | null;
  section: 'mine' | 'theirs';
}

/**
 * The deduped set of incoming scans in the window, as a CTE.
 *
 * ONE ROW PER PARCEL, KEYED ON THE 15-CHARACTER BASE.
 *
 * A box scanned in two batches — a second worker checking the same shelf — is
 * one return, shown with its latest scan. So is the same box read once as its
 * Código de Bulto and once as its EXPEDICIÓN, which the base catches and the
 * full code would not.
 *
 * The base is also the right grain for this screen rather than a compromise.
 * Returns are read as "which orders came back"; the row shows an order number
 * and a shop, both of which belong to the shipment, so the two boxes of a
 * multi-parcel shipment are one line about one order coming back.
 *
 * And it is what makes the tab's count and these sections agree: the count is
 * `count(DISTINCT base)` over the same window, so with nothing typed in the
 * search box the two sections sum to exactly the number on the tab.
 */
function windowed(since: Date, q: string): SQL {
  const search = q
    ? raw`AND (sc.base ILIKE ${`%${q}%`} OR sc.code_as_read ILIKE ${`%${q}%`})`
    : raw``;

  return raw`
    WITH seen AS (
      SELECT sc.id, sc.base, sc.code_as_read, sc.postal_code, sc.scanned_at,
             sc.order_number AS copied_order, sc.store_name AS copied_store,
             u.name AS worker,
             ${MATCH_COLUMNS}
        FROM scans sc
        JOIN users u ON u.id = sc.user_id
        ${matchLateral('sc')}
       WHERE sc.direction = 'incoming'
         AND sc.scanned_at >= ${ts(since)}
         ${search}
    ),
    one AS (
      SELECT DISTINCT ON (base) *
        FROM seen
       ORDER BY base, scanned_at DESC
    ),
    picked AS (
      SELECT one.*,
             CASE
               WHEN one.shipment_id IS NOT NULL OR one.copied_order IS NOT NULL THEN 'mine'
               ELSE 'theirs'
             END AS section
        FROM one
    )
  `;
}

export const returnsView = retryableRead('returns', async (
  opts: { q?: string; at?: Date } = {},
): Promise<ReturnsView> => {
  const q = (opts.q ?? '').trim();
  const since = new Date((opts.at ?? now()).getTime() - SCAN_RETENTION_DAYS * DAY);

  const [listResult, countResult] = await Promise.all([
    /*
     * The parcel's current state, and when it left the warehouse.
     *
     * The outgoing scan is found by BASE and not through `shipments`, which is
     * the whole reason it is a separate lateral: a parcel the thirty-day
     * cleanup removed still has its outgoing scan for the rest of the ninety
     * days, and "it left on the 2nd and came back on the 40th" is exactly the
     * story this screen exists to tell.
     */
    getDb().execute(raw`
      ${windowed(since, q)}
      SELECT r.*, ship.state,
             out_scan.scanned_at AS out_at, out_scan.worker AS out_by
        FROM (
          SELECT * FROM picked
           ORDER BY scanned_at DESC
           LIMIT ${RETURNS_LIMIT * 2}
        ) r
        LEFT JOIN shipments ship ON ship.id = r.shipment_id
        LEFT JOIN LATERAL (
          SELECT o.scanned_at, ou.name AS worker
            FROM scans o
            JOIN users ou ON ou.id = o.user_id
           WHERE o.direction = 'outgoing' AND o.base = r.base
           ORDER BY o.scanned_at DESC
           LIMIT 1
        ) out_scan ON true
       ORDER BY r.scanned_at DESC
    `),
    getDb().execute(raw`
      ${windowed(since, q)}
      SELECT count(*) FILTER (WHERE section = 'mine')::int AS mine,
             count(*) FILTER (WHERE section = 'theirs')::int AS theirs
        FROM picked
    `),
  ]);

  const raws = rowsOf<ReturnRaw>(listResult);
  const counts = rowsOf<{ mine: number | string; theirs: number | string }>(countResult)[0];

  const mine: ReturnRow[] = [];
  const theirs: ReturnRow[] = [];

  for (const r of raws) {
    const row = toReturnRow(r);
    if (r.section === 'mine') {
      if (mine.length < RETURNS_LIMIT) mine.push(row);
    } else if (theirs.length < RETURNS_LIMIT) {
      theirs.push(row);
    }
  }

  return {
    mine,
    theirs,
    mineTotal: Number(counts?.mine ?? 0),
    theirsTotal: Number(counts?.theirs ?? 0),
    q,
    days: SCAN_RETENTION_DAYS,
  };
});

function toReturnRow(r: ReturnRaw): ReturnRow {
  const live = resolveMatch(r);

  /*
   * The live match first, the copy second.
   *
   * Live, because a parcel uploaded after its return was scanned has to appear
   * with its order number without anybody scanning again. The copy, because a
   * parcel the cleanup has since removed has to keep the order number it had —
   * otherwise a matched return would jump to "Not in Return Shield" on day 31,
   * which is the one thing this screen must not do.
   */
  const label = live.match
    ? scanLabel(live.match)
    : r.copied_order
      ? { lead: r.copied_order, note: r.copied_store ?? '' } satisfies ScanLabel
      : null;

  return {
    id: r.id,
    base: r.base,
    postalCode: r.postal_code,
    back: scanMark(r.scanned_at, r.worker, 'incoming') ?? {
      label: 'Back in the warehouse', when: '', exactWhen: '', worker: r.worker,
    },
    left: scanMark(r.out_at, r.out_by, 'outgoing'),
    label,
    status: r.state ? stateLabels(r.state) : null,
    shipmentId: live.match?.shipmentId ?? null,
    parcelGone: live.match === null && r.copied_order !== null,
  };
}

/**
 * The count for the Returns tab. Its own table, so its own query.
 *
 * `count(DISTINCT base)` is the same grain the view dedupes on, so with an
 * empty search box the two sections sum to exactly this. It runs on every view
 * of the Parcels screen, which is why it is one index-only count over
 * `scans_direction_time_idx` rather than the view's CTE — the tab's number must
 * be cheap enough to pay for on a screen that is not even showing it.
 */
export const returnsCount = retryableRead('returns count', async (
  at: Date = now(),
): Promise<number> => {
  const since = new Date(at.getTime() - SCAN_RETENTION_DAYS * DAY);
  const result = await getDb().execute(raw`
    SELECT count(DISTINCT base)::int AS n
      FROM scans
     WHERE direction = 'incoming' AND scanned_at >= ${ts(since)}
  `);
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
});
