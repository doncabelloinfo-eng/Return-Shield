import { and, desc, eq, gte, isNull, sql as raw } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import { closures } from '@/db/schema';
import { now } from '@/lib/clock';
import { exact, human, madridMidnightUtc, madridParts } from '@/lib/time';
import { CLOSE_REASON_KEYS, closeReasonLabel, isCloseReason, type CloseReason } from '@/lib/escalation/close-reasons';
import { money } from '@/lib/escalation/decide';
import { retentionDays } from '@/lib/retention';

/**
 * Every parcel the operator gave up on.
 *
 * This reads `closures`, not `shipments`, and that is the point rather than an
 * implementation detail: the rolling thirty-day window deletes the order and
 * cascades through the shipment, so a list built from `shipments` would show a
 * write-off for a month and then quietly lose it. "How many did we lose last
 * quarter, and to what" has to survive the parcel it is about.
 *
 * The consequence to keep in mind is that a row here may have no parcel left
 * to open. `shipmentId` goes null when the window catches up, so the link is
 * conditional and the row still reads: order number, shop, code, reason, note
 * and value are all copied in at closing time.
 */

export interface ClosureRow {
  id: string;
  /** Null once the 30-day window has taken the parcel. */
  shipmentId: string | null;
  orderNumber: string;
  storeName: string;
  shippingCode: string;
  reason: string;
  reasonLabel: string;
  note: string;
  valueText: string;
  valueCents: number;
  daysSinceOrder: number;
  closedAt: string;
  closedExact: string;
}

export interface ReasonCount {
  reason: CloseReason;
  label: string;
  recent: number;
  allTime: number;
  recentValueCents: number;
}

export interface ClosuresView {
  rows: ClosureRow[];
  counts: ReasonCount[];
  /** Totals across every reason, for the heading. */
  recentTotal: number;
  allTimeTotal: number;
  recentValueText: string;
  /** "2026-10" keys with something in them, newest first, for the filter. */
  months: string[];
  stores: string[];
  total: number;
  page: number;
  pages: number;
  windowDays: number;
}

export const CLOSURES_PAGE_SIZE = 100;

export interface ClosuresQuery {
  reason?: string;
  store?: string;
  /** "2026-10". A Madrid calendar month. */
  month?: string;
  page?: number;
  at?: Date;
}

/** The Madrid month a date falls in, as the filter spells it. */
export function monthKey(at: Date): string {
  const p = madridParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** The half-open Madrid month that `key` names, or null if it is nonsense. */
function monthRange(key: string): { from: Date; until: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return {
    from: madridMidnightUtc(year, month, 1),
    until: madridMidnightUtc(year, month + 1, 1),
  };
}

export async function closuresView(opts: ClosuresQuery = {}): Promise<ClosuresView> {
  const at = opts.at ?? now();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const windowDays = retentionDays();
  const since = new Date(at.getTime() - windowDays * 86_400_000);

  const reason = opts.reason && isCloseReason(opts.reason) ? opts.reason : null;
  const store = (opts.store ?? '').trim();
  const month = opts.month ? monthRange(opts.month) : null;

  // Undone closures are excluded everywhere. The row is kept so the trail
  // shows somebody changed their mind, and counting it would overstate how
  // many parcels were actually written off.
  const live = isNull(closures.undoneAt);
  const where = and(
    live,
    reason ? eq(closures.reason, reason) : undefined,
    store ? eq(closures.storeName, store) : undefined,
    month ? gte(closures.closedAt, month.from) : undefined,
    // `ts()`, not the bare Date: see db/index.ts.
    month ? raw`${closures.closedAt} < ${ts(month.until)}` : undefined,
  );

  const [rows, totalRow, countRows, monthRows, storeRows] = await Promise.all([
    getDb().select().from(closures).where(where)
      .orderBy(desc(closures.closedAt))
      .limit(CLOSURES_PAGE_SIZE).offset((page - 1) * CLOSURES_PAGE_SIZE),

    getDb().select({ n: raw<number>`count(*)::int` }).from(closures).where(where),

    // Both numbers in one pass: the window the operator is working in, and the
    // whole history. All time is the one that answers "is this getting worse".
    getDb().select({
      reason: closures.reason,
      allTime: raw<number>`count(*)::int`,
      recent: raw<number>`count(*) FILTER (WHERE ${closures.closedAt} >= ${ts(since)})::int`,
      recentValue: raw<number>`COALESCE(sum(${closures.valueCents}) FILTER (WHERE ${closures.closedAt} >= ${ts(since)}), 0)::int`,
    }).from(closures).where(live).groupBy(closures.reason),

    getDb().execute(raw`
      SELECT DISTINCT to_char(closed_at AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS key
        FROM closures WHERE undone_at IS NULL
       ORDER BY key DESC
    `),

    getDb().selectDistinct({ name: closures.storeName }).from(closures).where(live)
      .orderBy(closures.storeName),
  ]);

  const byReason = new Map(countRows.map((r) => [r.reason, r]));
  const counts: ReasonCount[] = CLOSE_REASON_KEYS.map((key) => ({
    reason: key,
    label: closeReasonLabel(key),
    recent: byReason.get(key)?.recent ?? 0,
    allTime: byReason.get(key)?.allTime ?? 0,
    recentValueCents: byReason.get(key)?.recentValue ?? 0,
  }));

  const total = totalRow[0]?.n ?? 0;
  const recentTotal = counts.reduce((a, c) => a + c.recent, 0);
  const recentValue = counts.reduce((a, c) => a + c.recentValueCents, 0);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      shipmentId: r.shipmentId,
      orderNumber: r.orderNumber,
      storeName: r.storeName,
      shippingCode: r.shippingCode,
      reason: r.reason,
      reasonLabel: closeReasonLabel(r.reason),
      note: r.note,
      valueText: money(r.valueCents),
      valueCents: r.valueCents,
      daysSinceOrder: r.daysSinceOrder,
      closedAt: human(r.closedAt, at),
      closedExact: exact(r.closedAt),
    })),
    counts,
    recentTotal,
    allTimeTotal: counts.reduce((a, c) => a + c.allTime, 0),
    recentValueText: money(recentValue),
    months: rowsOf<{ key: string }>(monthRows).map((m) => m.key),
    stores: storeRows.map((s) => s.name),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / CLOSURES_PAGE_SIZE)),
    windowDays,
  };
}

/** How many write-offs stand, all time. The Parcels tab's count. */
export async function closureCount(): Promise<number> {
  const [row] = await getDb().select({ n: raw<number>`count(*)::int` })
    .from(closures).where(isNull(closures.undoneAt));
  return row?.n ?? 0;
}
