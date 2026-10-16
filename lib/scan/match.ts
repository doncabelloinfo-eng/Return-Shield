import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { CODE_BASE_LENGTH, type CorreosCode } from './codes';
import type { ScanDirection } from './model';

/**
 * Which parcel a scanned code is.
 *
 * MATCHED WHEN READ, NOT WHEN SCANNED. A scan holds a code, not a shipment id,
 * and this is run every time somebody asks. That is the point: a TikTok or
 * Amazon parcel is usually scanned out days before its file is uploaded, and a
 * scan that had frozen "no such parcel" at scan time would still say so after
 * the upload brought the parcel in — the operator would be told a parcel never
 * left the warehouse when it left on Tuesday.
 *
 * THE LINK IS THE FIRST FIFTEEN CHARACTERS. They are the one part the Código de
 * Bulto and the EXPEDICIÓN share, and `shipments.shipping_code` holds whichever
 * of the two its source happened to give us — Shopify's fulfilment carries the
 * expedición, a marketplace file sometimes carries the bulto. See
 * lib/scan/codes.ts.
 *
 * ONE RULE, THREE CALLERS. The resolution below is written once as SQL and
 * once as the handful of lines that read its answer, and the scan API, the
 * phone's batch list and the Returns tab all go through both. Three copies of
 * "what does this code match" is three answers to it.
 */

export interface ScanMatch {
  shipmentId: string;
  orderNumber: string;
  storeName: string;
  storePlatform: string;
}

export interface MatchAnswer {
  /** The one parcel this code is, or null when there is no single answer. */
  match: ScanMatch | null;
  /**
   * How many parcels share this code's base.
   *
   * Two or more with nothing matching exactly is a multi-parcel shipment: the
   * worker scanned the EXPEDICIÓN, which names the shipment rather than one of
   * its boxes. The phone says "2 parcels with this number" instead of picking
   * one, because picking one is how a parcel gets marked as having left the
   * warehouse while it is still on a shelf.
   */
  sharing: number;
}

/**
 * `left(shipping_code, 15)`, written from the constant so this and
 * lib/scan/codes.ts cannot drift.
 *
 * Literal SQL rather than a bound parameter on purpose: the functional index
 * `shipments_code_base_idx` is on the expression with a constant 15, and
 * Postgres will not match it against `left(shipping_code, $1)`.
 */
function baseExpr(alias: string): SQL {
  return raw.raw(`left(${alias}.shipping_code, ${CODE_BASE_LENGTH})`);
}

/**
 * The resolution, as two LATERAL joins against anything that has a
 * `code_as_read` and a `base`.
 *
 * `m` is the parcel this code names — the exact code first, so a worker who
 * read the Código de Bulto gets the box they are holding rather than the oldest
 * row of the shipment. `n` is how many parcels share the base, which is what
 * tells a single parcel apart from a multi-parcel shipment.
 *
 * Both are index lookups on `shipments_code_base_idx`, so a batch of three
 * hundred scans costs six hundred lookups rather than six hundred table scans.
 */
export function matchLateral(scan: string): SQL {
  const sc = raw.identifier(scan);
  return raw`
    LEFT JOIN LATERAL (
      SELECT s.id AS shipment_id, o.order_number, st.name AS store_name, st.platform,
             (s.shipping_code = ${sc}.code_as_read) AS exact
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        JOIN stores st ON st.id = o.store_id
       WHERE ${baseExpr('s')} = ${sc}.base
       ORDER BY (s.shipping_code = ${sc}.code_as_read) DESC, s.created_at ASC
       LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS sharing
        FROM shipments s2
       WHERE ${baseExpr('s2')} = ${sc}.base
    ) n ON true
  `;
}

/** What a row selected through `matchLateral` looks like. */
export interface MatchColumns {
  shipment_id: string | null;
  order_number: string | null;
  store_name: string | null;
  platform: string | null;
  exact: boolean | null;
  sharing: number | string | null;
}

/** The columns `matchLateral` provides, for a SELECT list. */
export const MATCH_COLUMNS: SQL = raw`
  m.shipment_id, m.order_number, m.store_name, m.platform, m.exact, n.sharing
`;

/**
 * The decision, in the one place it is made.
 *
 * Nothing matched → nothing. Exactly one parcel, or an exact hit among several
 * → that parcel. Several, with only the base to go on → no parcel and the
 * count, which is what the phone turns into "2 parcels with this number".
 */
export function resolveMatch(row: MatchColumns): MatchAnswer {
  const sharing = Number(row.sharing ?? 0);
  if (!row.shipment_id || sharing === 0) return { match: null, sharing: 0 };
  if (sharing > 1 && !row.exact) return { match: null, sharing };

  return {
    match: {
      shipmentId: row.shipment_id,
      orderNumber: row.order_number ?? '',
      storeName: row.store_name ?? '',
      storePlatform: row.platform ?? '',
    },
    sharing,
  };
}

/**
 * One code, resolved. Used when a scan is stored, to copy the order number and
 * shop onto it.
 *
 * It runs the SAME SQL as the batch list, over a one-row VALUES, rather than a
 * near-identical query of its own.
 */
export async function matchForCode(code: CorreosCode): Promise<MatchAnswer> {
  const result = await getDb().execute(raw`
    SELECT ${MATCH_COLUMNS}
      FROM (VALUES (${code.raw}::text, ${code.base}::text)) AS sc(code_as_read, base)
      ${matchLateral('sc')}
  `);

  const row = rowsOf<MatchColumns>(result)[0];
  return row ? resolveMatch(row) : { match: null, sharing: 0 };
}

/**
 * The latest scan of one shipment in one direction, as a LATERAL join.
 *
 * Shared by the Parcels list, the parcel page and the pre-admission filter,
 * because three copies of this predicate is three answers to "has it left the
 * warehouse".
 *
 * The NOT EXISTS is the multi-parcel rule from the other side. A scan whose
 * exact code IS some other parcel's `shipping_code` has already named its box,
 * so it must not badge this one as well — without it, scanning parcel 01 of a
 * two-parcel shipment would mark parcel 02 as having left the warehouse too.
 */
export function latestScanLateral(
  direction: ScanDirection,
  as: string,
  shipments = 's',
): SQL {
  const code = raw.raw(`${shipments}.shipping_code`);
  return raw`
    LEFT JOIN LATERAL (
      SELECT sc.scanned_at, u.name AS worker
        FROM scans sc
        JOIN users u ON u.id = sc.user_id
       WHERE sc.direction = ${direction}
         AND sc.base = ${baseExpr(shipments)}
         AND (
           sc.code_as_read = ${code}
           OR NOT EXISTS (
             SELECT 1 FROM shipments other WHERE other.shipping_code = sc.code_as_read
           )
         )
       ORDER BY sc.scanned_at DESC
       LIMIT 1
    ) ${raw.identifier(as)} ON true
  `;
}
