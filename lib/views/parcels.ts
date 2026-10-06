import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import { now } from '@/lib/clock';
import {
  exact, human, madridDaysBetween, workingDayCutoff, workingDaysSince, shortDate,
} from '@/lib/time';
import { stateLabels, eventLabels, type Bilingual } from '@/lib/carriers/correos/state-map';
import { closeReasonLabel } from '@/lib/escalation/close-reasons';
import { money } from '@/lib/escalation/decide';
import { displayPhone } from '@/lib/import/phone';
import { retentionDays } from '@/lib/retention';
import { closureCount } from './closures';

/**
 * Every parcel, by status. The screen the operator did not have.
 *
 * Today lists only parcels with a next action, and Post office only the ones a
 * post office is holding. Eleven parcels moving normally through Correos were
 * therefore invisible: in the database, tracked, and on no screen. This answers
 * "where is everything" instead of "what do I have to do".
 *
 * TWO RULES SHAPE THIS FILE.
 *
 * It filters and pages in SQL. `officeView` loads every row and filters in
 * memory, which is fine for the few dozen parcels a post office holds and
 * wrong here: a thousand parcels a day means thirty thousand rows in the
 * retention window, and a screen that loads all of them to show a hundred gets
 * slower every day until it times out.
 *
 * And every tab's count comes from the same predicate as its list, in one
 * statement. Two queries that agree today drift the moment somebody edits one,
 * and a tab that says 7 and lists 5 is a screen nobody trusts again.
 */

/* ------------------------------------------------------------------- tabs */

export type ParcelTabId =
  | 'all_open'
  | 'created' | 'stuck_pre_admission'
  | 'accepted' | 'in_transit' | 'out_for_delivery'
  | 'failed' | 'bad_address' | 'at_office' | 'refused'
  | 'returning' | 'returned' | 'delivered' | 'collected' | 'stale'
  | 'stuck_30' | 'to_review' | 'closed';

export interface ParcelTab extends Bilingual {
  id: ParcelTabId;
  /** Shown red when it has anything in it. These are the ones that bite. */
  urgent?: boolean;
}

/**
 * In journey order, so the row of tabs reads like the life of a parcel.
 *
 * English first in every one. Correos' word sits beneath it, smaller, because
 * it is what the public tracker says and therefore what matches when somebody
 * rings them — but it is never the only text on a tab.
 */
export const PARCEL_TABS: readonly ParcelTab[] = [
  { id: 'all_open', en: 'All not finished', es: '' },
  { id: 'created', en: 'Pre-admission', es: 'Pre-admisión / Prerregistrado' },
  { id: 'stuck_pre_admission', en: 'Stuck in pre-admission', es: 'Pre-admisión', urgent: true },
  { id: 'accepted', en: 'Accepted by Correos', es: 'Admitido' },
  { id: 'in_transit', en: 'On the way', es: 'Clasificado / En tránsito' },
  { id: 'out_for_delivery', en: 'Out for delivery', es: 'En reparto' },
  { id: 'failed', en: 'Failed delivery', es: 'Ausente / Intento de entrega fallido', urgent: true },
  { id: 'bad_address', en: 'Wrong address', es: 'Dirección incorrecta', urgent: true },
  { id: 'at_office', en: 'Waiting at the post office', es: 'Disponible en oficina' },
  { id: 'refused', en: 'Refused by customer', es: 'Rehusado' },
  { id: 'returning', en: 'Coming back', es: 'En devolución' },
  { id: 'returned', en: 'Returned', es: 'Devuelto' },
  { id: 'delivered', en: 'Delivered', es: 'Entregado' },
  { id: 'collected', en: 'Picked up at the post office', es: 'Entregado en oficina' },
  { id: 'stale', en: 'No news from Correos', es: '' },
  { id: 'stuck_30', en: 'Stuck 30+ days, not finished', es: '', urgent: true },
  { id: 'to_review', en: 'To review (Correos said something new)', es: "Correos' words" },
  { id: 'closed', en: 'Closed by hand', es: '' },
];

export function isParcelTab(x: string): x is ParcelTabId {
  return PARCEL_TABS.some((t) => t.id === x);
}

export const PAGE_SIZE = 100;

/* -------------------------------------------------------------- predicates */

/**
 * Finished means nothing more will happen on its own.
 *
 * A parcel closed by hand counts as finished, which is the same answer the
 * retention sweep gives — written once here so the screen and the cleanup
 * cannot disagree about which parcels are still live.
 */
const FINISHED = raw`(b.state IN ('delivered', 'collected', 'returned') OR b.dropped_at IS NOT NULL)`;



/**
 * One SQL predicate per tab, keyed by id.
 *
 * `cutoff` is the pre-admission one, worked out in JS by walking back over
 * working days — see `workingDayCutoff`. It arrives as a single timestamp so
 * the database can use an index, rather than as per-row weekday arithmetic
 * Postgres would have to do thirty thousand times.
 */
function predicates(cutoff: Date, staleBefore: Date): Record<ParcelTabId, SQL> {
  const state = (s: string) => raw`b.state = ${s}`;
  const cutoffAt = ts(cutoff);
  const staleAt = ts(staleBefore);

  return {
    all_open: raw`NOT ${FINISHED}`,
    created: state('created'),
    // Still in pre-admission, and two working days have gone by. The reference
    // time is the Prerregistrado event, or the row's own creation when Correos
    // has never said anything at all.
    stuck_pre_admission: raw`b.state = 'created' AND b.pre_ref < ${cutoffAt}`,
    accepted: state('accepted'),
    in_transit: state('in_transit'),
    out_for_delivery: state('out_for_delivery'),
    failed: state('failed'),
    bad_address: state('bad_address'),
    at_office: state('at_office'),
    refused: state('refused'),
    returning: state('returning'),
    returned: state('returned'),
    delivered: state('delivered'),
    collected: state('collected'),
    stale: state('stale'),
    // Past the retention window and still going. The cleanup keeps these
    // rather than deleting them, so something has to show them: a parcel still
    // moving at thirty-one days is exactly the one that needs a human.
    stuck_30: raw`NOT ${FINISHED} AND b.order_created_at < ${staleAt}`,
    to_review: raw`b.needs_review`,
    closed: raw`b.dropped_at IS NOT NULL`,
  };
}

/* ------------------------------------------------------------------- rows */

export interface ParcelListRow {
  id: string;
  state: string;
  /** English label, Correos' word beneath. */
  status: Bilingual;
  orderNumber: string;
  customerName: string;
  storeName: string;
  /** The newest Correos event: our English, their sentence, and when. */
  event: (Bilingual & { when: string; exactWhen: string }) | null;
  /** How long it has sat in this status, in words. */
  inStatus: string;
  daysInStatus: number;
  deadline: string | null;
  deadlineExact: string | null;
  paymentMethod: 'prepaid' | 'cod';
  valueText: string;
  phoneDisplay: string;
  phoneE164: string | null;
  town: string;
  /**
   * The badges a row carries wherever it appears, not only in its own tab.
   * A parcel stuck in pre-admission is stuck whether you found it under
   * "Pre-admission" or under "All not finished".
   */
  badges: string[];
  closed: { reason: string; note: string; at: string } | null;
}

export interface TabCount extends ParcelTab {
  count: number;
}

export interface ParcelsView {
  tabs: TabCount[];
  tab: ParcelTab;
  rows: ParcelListRow[];
  total: number;
  page: number;
  pages: number;
  stores: string[];
}

export interface ParcelsQuery {
  status?: string;
  q?: string;
  store?: string;
  page?: number;
  at?: Date;
}

/**
 * The joined set every query below reads from.
 *
 * A CTE rather than a view so it lives next to the predicates that use it. The
 * two LATERALs are the interesting part: `pre` is the Prerregistrado event and
 * `ev` the newest one of any kind, each an index lookup with a LIMIT rather
 * than a sort of the whole events table.
 */
function base(): SQL {
  return raw`
    WITH b AS (
      SELECT s.id, s.state, s.state_since, s.office_deadline, s.dropped_at,
             s.close_reason, s.close_note, s.created_at AS shipment_created_at,
             o.order_number, o.customer_name, o.total_value_cents, o.payment_method,
             o.phone_e164, o.city, o.created_at AS order_created_at,
             st.name AS store_name,
             COALESCE(pre.first_at, s.created_at) AS pre_ref,
             ev.event_desc, ev.mapped_state, ev.occurred_at,
             (rev.id IS NOT NULL) AS needs_review
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        JOIN stores st ON st.id = o.store_id
        LEFT JOIN LATERAL (
          SELECT min(e.occurred_at) AS first_at
            FROM shipment_events e
           WHERE e.shipment_id = s.id AND e.event_code = 'A090000V'
        ) pre ON true
        LEFT JOIN LATERAL (
          SELECT e.event_desc, e.mapped_state, e.occurred_at, e.event_code
            FROM shipment_events e
           WHERE e.shipment_id = s.id
           ORDER BY e.occurred_at DESC
           LIMIT 1
        ) ev ON true
        LEFT JOIN event_review_queue rev
          ON rev.event_code = ev.event_code
         AND rev.event_desc = ev.event_desc
         AND rev.resolved_at IS NULL
    )
  `;
}

/** The search box and the shop filter, as one predicate. */
function filters(q: string, store: string): SQL {
  const parts: SQL[] = [];

  if (q) {
    const like = `%${q}%`;
    parts.push(raw`(
      b.customer_name ILIKE ${like}
      OR b.order_number ILIKE ${like}
      OR EXISTS (SELECT 1 FROM shipments s2 WHERE s2.id = b.id AND s2.shipping_code ILIKE ${like})
      OR COALESCE(b.city, '') ILIKE ${like}
    )`);
  }

  if (store) parts.push(raw`b.store_name = ${store}`);

  if (!parts.length) return raw`TRUE`;
  return raw.join(parts, raw` AND `);
}

export async function parcelsView(opts: ParcelsQuery = {}): Promise<ParcelsView> {
  const at = opts.at ?? now();
  const q = (opts.q ?? '').trim();
  const store = (opts.store ?? '').trim();
  const page = Math.max(1, Math.floor(opts.page ?? 1));

  const tabId: ParcelTabId = opts.status && isParcelTab(opts.status) ? opts.status : 'all_open';
  const cutoff = workingDayCutoff(at, 2);
  const staleBefore = new Date(at.getTime() - retentionDays() * 86_400_000);
  const where = predicates(cutoff, staleBefore);
  const extra = filters(q, store);

  // Counts for every tab in one pass, with the search and shop filter applied
  // — a count that ignored the filter would promise rows the list then does
  // not show.
  const countRow = raw.join(
    PARCEL_TABS.map((t) => raw`count(*) FILTER (WHERE ${where[t.id]}) AS ${raw.identifier(t.id)}`),
    raw`, `,
  );

  const [countResult, pageResult, storeResult, closedCount] = await Promise.all([
    getDb().execute(raw`${base()} SELECT ${countRow} FROM b WHERE ${extra}`),
    getDb().execute(raw`
      ${base()}
      SELECT b.*,
             (SELECT s3.shipping_code FROM shipments s3 WHERE s3.id = b.id) AS shipping_code,
             count(*) OVER () AS total_rows
        FROM b
       WHERE ${where[tabId]} AND ${extra}
       ORDER BY ${orderFor(tabId)}
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
    `),
    getDb().execute(raw`SELECT name FROM stores ORDER BY name`),
    closureCount(),
  ]);

  const counts = rowsOf<Record<string, string | number>>(countResult)[0] ?? {};
  const raws = rowsOf<RawParcelRow>(pageResult);
  const total = raws.length ? Number(raws[0].total_rows) : 0;

  return {
    // Every count but one comes from the single statement above, so a tab and
    // its list cannot disagree. `closed` is the exception on purpose: its list
    // is the `closures` table, which outlives the parcels, so counting
    // shipments would undercount by every write-off the window has since
    // cleaned up. Counted from the same table its list reads.
    tabs: PARCEL_TABS.map((t) => ({
      ...t,
      count: t.id === 'closed' ? closedCount : Number(counts[t.id] ?? 0),
    })),
    tab: PARCEL_TABS.find((t) => t.id === tabId) ?? PARCEL_TABS[0],
    rows: raws.map((r) => toRow(r, at, cutoff)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    stores: rowsOf<{ name: string }>(storeResult).map((s) => s.name),
  };
}

/**
 * Most urgent first, per tab.
 *
 * The post-office tab goes by deadline because that is the number that costs
 * money; the stuck tabs go oldest-first because the oldest is the worst; and
 * everything else goes by the last thing that happened, so the list reads as
 * "what moved recently".
 */
function orderFor(tab: ParcelTabId): SQL {
  if (tab === 'at_office') return raw`b.office_deadline ASC NULLS LAST, b.order_created_at ASC`;
  if (tab === 'stuck_pre_admission' || tab === 'stuck_30') return raw`b.order_created_at ASC`;
  if (tab === 'closed') return raw`b.dropped_at DESC NULLS LAST`;
  return raw`b.state_since DESC NULLS LAST, b.order_created_at DESC`;
}

/* ----------------------------------------------------------------- mapping */

interface RawParcelRow {
  id: string;
  state: string;
  state_since: string | null;
  office_deadline: string | null;
  dropped_at: string | null;
  close_reason: string | null;
  close_note: string | null;
  shipment_created_at: string;
  order_number: string;
  customer_name: string;
  total_value_cents: number;
  payment_method: 'prepaid' | 'cod';
  phone_e164: string | null;
  city: string | null;
  order_created_at: string;
  store_name: string;
  pre_ref: string;
  event_desc: string | null;
  mapped_state: string | null;
  occurred_at: string | null;
  needs_review: boolean;
  shipping_code: string;
  total_rows: number | string;
}

function toRow(r: RawParcelRow, at: Date, cutoff: Date): ParcelListRow {
  const stateSince = r.state_since ? new Date(r.state_since) : new Date(r.shipment_created_at);
  const orderAt = new Date(r.order_created_at);
  const preRef = new Date(r.pre_ref);
  const occurredAt = r.occurred_at ? new Date(r.occurred_at) : null;

  const daysInStatus = Math.max(0, madridDaysBetween(stateSince, at));
  const finished = ['delivered', 'collected', 'returned'].includes(r.state) || r.dropped_at !== null;

  const badges: string[] = [];

  // Both badges travel with the row, not with the tab. Finding a stuck parcel
  // under "All not finished" and not being told it is stuck would make the
  // badge a property of where you looked rather than of the parcel.
  if (r.state === 'created' && preRef.getTime() < cutoff.getTime()) {
    const n = workingDaysSince(preRef, at);
    badges.push(`${n} working ${n === 1 ? 'day' : 'days'} in pre-admission`);
  }

  const daysSinceOrder = madridDaysBetween(orderAt, at);
  if (!finished && daysSinceOrder >= retentionDays()) {
    badges.push(`${daysSinceOrder} days, still not finished`);
  }

  return {
    id: r.id,
    state: r.state,
    status: stateLabels(r.state),
    orderNumber: r.order_number,
    customerName: r.customer_name,
    storeName: r.store_name,
    event: occurredAt && r.event_desc
      ? {
        ...eventLabels(r.mapped_state, r.event_desc),
        when: `${shortDate(occurredAt)} · ${exact(occurredAt).split(', ')[1] ?? ''}`,
        exactWhen: exact(occurredAt),
      }
      : null,
    inStatus: daysInStatus === 0 ? 'today' : `${daysInStatus} ${daysInStatus === 1 ? 'day' : 'days'}`,
    daysInStatus,
    deadline: r.office_deadline ? human(new Date(r.office_deadline), at) : null,
    deadlineExact: r.office_deadline ? exact(new Date(r.office_deadline)) : null,
    paymentMethod: r.payment_method,
    valueText: money(r.total_value_cents),
    phoneDisplay: displayPhone(r.phone_e164),
    phoneE164: r.phone_e164,
    town: r.city ?? '',
    badges,
    closed: r.dropped_at
      ? {
        reason: closeReasonLabel(r.close_reason),
        note: r.close_note ?? '',
        at: human(new Date(r.dropped_at), at),
      }
      : null,
  };
}
