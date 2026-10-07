import { sql as raw, type SQL } from 'drizzle-orm';
import { getDb, rowsOf, at as ts } from '@/db';
import { now } from '@/lib/clock';
import {
  daysAtOffice, exact, human, madridDaysBetween, madridMidnightUtc, workingDayCutoff,
  workingDaysSince, shortDate, OFFICE_CRIT_DAYS,
} from '@/lib/time';
import { cutoffFor } from '@/lib/cleanup';
import { stateLabels, eventLabels, type Bilingual } from '@/lib/carriers/correos/state-map';
import { closeReasonLabel } from '@/lib/escalation/close-reasons';
import { customerLabel, isMarketplace, realFirstName } from '@/lib/orders/customer-label';
import { shopifyOrderLink } from '@/lib/orders/shopify-link';
import {
  emailLink, mapsLink, officeDetails, officeEmailSubject, whatsappLink,
} from '@/lib/messaging/build-message';
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
  | 'created' | 'stuck_pre_admission' | 'stuck_same_status'
  | 'accepted' | 'in_transit' | 'out_for_delivery'
  | 'failed' | 'bad_address' | 'at_office' | 'missed_delivery' | 'refused'
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
  { id: 'stuck_same_status', en: 'Same status 3+ working days', es: '', urgent: true },
  { id: 'accepted', en: 'Accepted by Correos', es: 'Admitido' },
  { id: 'in_transit', en: 'On the way', es: 'Clasificado / En tránsito' },
  { id: 'out_for_delivery', en: 'Out for delivery', es: 'En reparto' },
  { id: 'failed', en: 'Failed delivery', es: 'Ausente / Intento de entrega fallido', urgent: true },
  { id: 'bad_address', en: 'Wrong address', es: 'Dirección incorrecta', urgent: true },
  { id: 'at_office', en: 'Waiting at the post office', es: 'Disponible en oficina' },
  {
    id: 'missed_delivery',
    en: 'Missed delivery, at the post office',
    es: 'Ausente → Disponible en oficina',
    urgent: true,
  },
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
 * The states "same status for three working days" applies to.
 *
 * Deliberately not all of them. `created` has its own two-working-day flag;
 * `at_office` has a deposit countdown that is a better signal than silence;
 * and `refused`, `returning` and `stale` are either already moving the right
 * way or already flagged. Delivery takes two to three working days, so these
 * five are the ones where three days of silence means late.
 */
const SAME_STATUS_STATES = ['accepted', 'in_transit', 'out_for_delivery', 'failed', 'bad_address'];



/**
 * One SQL predicate per tab, keyed by id.
 *
 * `cutoff` is the pre-admission one, worked out in JS by walking back over
 * working days — see `workingDayCutoff`. It arrives as a single timestamp so
 * the database can use an index, rather than as per-row weekday arithmetic
 * Postgres would have to do thirty thousand times.
 */
function predicates(cutoff: Date, sameStatusCutoff: Date, staleBefore: Date): Record<ParcelTabId, SQL> {
  const state = (s: string) => raw`b.state = ${s}`;
  const cutoffAt = ts(cutoff);
  const sameStatusAt = ts(sameStatusCutoff);
  const staleAt = ts(staleBefore);

  return {
    all_open: raw`NOT ${FINISHED}`,
    created: state('created'),
    // Still in pre-admission, and two working days have gone by. The reference
    // time is the Prerregistrado event, or the row's own creation when Correos
    // has never said anything at all.
    stuck_pre_admission: raw`b.state = 'created' AND b.pre_ref < ${cutoffAt}`,
    /*
     * Three full working days in the same state. Delivery takes two to three,
     * so this is the parcel that has stopped moving without Correos saying
     * anything is wrong.
     *
     * `status_ref` is the state's own start time, falling back to the last
     * event and then to the ship date — a parcel whose state we inferred
     * without an event still has to be measurable.
     */
    stuck_same_status: raw`
      b.state IN ('accepted', 'in_transit', 'out_for_delivery', 'failed', 'bad_address')
      AND b.dropped_at IS NULL
      AND b.status_ref < ${sameStatusAt}
    `,
    accepted: state('accepted'),
    in_transit: state('in_transit'),
    out_for_delivery: state('out_for_delivery'),
    failed: state('failed'),
    bad_address: state('bad_address'),
    at_office: state('at_office'),
    /*
     * At the office BECAUSE a delivery was attempted and missed — these are
     * the customers to ring today.
     *
     * A parcel sent straight to an office the customer chose was never out for
     * delivery and nobody missed anything, so it stays under "Waiting at the
     * post office". The distinction is whether a failed or out-for-delivery
     * event happened BEFORE the parcel reached the office.
     */
    missed_delivery: raw`b.state = 'at_office' AND b.dropped_at IS NULL AND b.missed_delivery`,
    refused: state('refused'),
    returning: state('returning'),
    returned: state('returned'),
    delivered: state('delivered'),
    collected: state('collected'),
    stale: state('stale'),
    // Past the retention window and still going. The cleanup keeps these
    // rather than deleting them, so something has to show them: a parcel still
    // moving at thirty-one days is exactly the one that needs a human.
    // By SHIP date, and the same Madrid-midnight cutoff the cleanup uses. It
    // used to subtract 30 × 86,400,000 ms from `orders.created_at`, which the
    // cleanup deliberately avoids — and after a history pull `created_at` is
    // the day of the pull, so the two disagreed about every pulled parcel.
    stuck_30: raw`NOT ${FINISHED} AND b.ship_ref < ${staleAt}`,
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
  shippingCode: string;
  /** The name, or "Amazon order 404-…" when the source gave none. */
  customerName: string;
  storeName: string;
  storePlatform: string;
  /** When the customer ordered. Null for the marketplace tracking files. */
  orderedOn: string | null;
  /** When it was handed to Correos. */
  shippedOn: string;
  shippedExact: string;
  /** The newest Correos event: our English, their sentence, and when. */
  event: (Bilingual & { when: string; exactWhen: string }) | null;
  /** How long it has sat in this status, in words. */
  inStatus: string;
  daysInStatus: number;
  /**
   * "At the office since 20 Sep · 8 days", or null when it is not at one.
   *
   * This replaced a "goes back on" date, which was worked out from a deposit
   * window nobody had confirmed with Correos. Correos says when a parcel
   * arrived, never when it will leave.
   */
  atOffice: { since: string; sinceExact: string; days: number; late: boolean } | null;
  paymentMethod: 'prepaid' | 'cod';
  valueText: string;
  phoneDisplay: string;
  phoneE164: string | null;
  email: string | null;
  town: string;
  /** How many times Correos tried and found nobody. */
  attempts: number;
  /** The office Correos named, or null when they named none. */
  officeName: string | null;
  officeAddress: string | null;
  mapsHref: string;
  /**
   * The finished Spanish text for this parcel — the same `officeDetails` the
   * parcel page copies, built here so a contact row needs nothing else.
   */
  messageText: string;
  waHref: string;
  emailHref: string;
  /** The order in the Shopify admin, or '' when there is no real link. */
  shopifyHref: string;
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
  /** A Madrid day, "2026-10-06". Filters on the ship date. */
  date?: string;
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
      SELECT s.id, s.state, s.state_since, s.dropped_at,
             s.close_reason, s.close_note, s.created_at AS shipment_created_at,
             s.shipping_code, s.office_arrived_at,
             o.order_number, o.customer_name, o.total_value_cents, o.payment_method,
             o.phone_e164, o.email, o.city, o.placed_at, o.created_at AS order_created_at,
             st.name AS store_name, st.platform AS store_platform,
             st.shop_domain, o.external_order_id,
             of.name AS office_name, of.address AS office_address,
             of.opening_hours AS office_hours,
             COALESCE(pre.first_at, s.created_at) AS pre_ref,
             COALESCE(s.shipped_at, s.created_at) AS ship_ref,
             -- When the current state began. state_since is the Correos event
             -- time; a state we inferred without one still has to be
             -- measurable, so the last event and then the ship date stand in.
             COALESCE(s.state_since, s.last_event_at, s.shipped_at, s.created_at) AS status_ref,
             o.placed_at IS NOT NULL AS has_order_date,
             attempts.n AS failed_attempts,
             (attempts.n > 0 OR tried.n > 0) AS missed_delivery,
             ev.event_desc, ev.mapped_state, ev.occurred_at,
             (rev.id IS NOT NULL) AS needs_review
        FROM shipments s
        JOIN orders o ON o.id = s.order_id
        JOIN stores st ON st.id = o.store_id
        LEFT JOIN offices of ON of.id = s.office_id
        LEFT JOIN LATERAL (
          SELECT min(e.occurred_at) AS first_at
            FROM shipment_events e
           WHERE e.shipment_id = s.id AND e.event_code = 'A090000V'
        ) pre ON true
        -- How many times Correos tried and found nobody. Shown on the row, so
        -- the operator can say "they have tried twice" on the phone.
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS n
            FROM shipment_events e
           WHERE e.shipment_id = s.id
             AND e.mapped_state = 'failed'
             AND (s.office_arrived_at IS NULL OR e.occurred_at <= s.office_arrived_at)
        ) attempts ON true
        -- Out for delivery before it reached the office counts as an attempt
        -- even with no failed event: Correos does not always send one.
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS n
            FROM shipment_events e
           WHERE e.shipment_id = s.id
             AND e.mapped_state = 'out_for_delivery'
             AND (s.office_arrived_at IS NULL OR e.occurred_at <= s.office_arrived_at)
        ) tried ON true
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

/**
 * The Madrid day a `?date=2026-10-06` names, as a half-open range.
 *
 * Half-open rather than two inclusive comparisons: a parcel shipped at
 * 23:59:59.4 on the 6th belongs to the 6th, and `<= end of day` written with a
 * whole second loses it.
 */
export function parseDayFilter(value: string | undefined): { from: Date; until: Date; key: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;

  const [, y, mo, d] = m;
  const month = Number(mo);
  const dayOfMonth = Number(d);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;

  const from = madridMidnightUtc(Number(y), month, dayOfMonth);
  const until = madridMidnightUtc(Number(y), month, dayOfMonth + 1);
  // `dayOfMonth + 1` rolls over months and years by itself, and a date like
  // 2026-02-31 lands on 3 March rather than throwing — which is the same
  // answer Postgres would give and better than an error on a typed URL.
  return { from, until, key: `${y}-${mo}-${d}` };
}

/** The search box, the shop filter and the ship-date filter, as one predicate. */
function filters(q: string, store: string, day: { from: Date; until: Date } | null): SQL {
  const parts: SQL[] = [];

  if (q) {
    const like = `%${q}%`;
    parts.push(raw`(
      b.customer_name ILIKE ${like}
      OR b.order_number ILIKE ${like}
      OR b.shipping_code ILIKE ${like}
      OR COALESCE(b.city, '') ILIKE ${like}
    )`);
  }

  if (store) parts.push(raw`b.store_name = ${store}`);

  // On the ship date, because that is the question the operator asks: "what
  // went out on Tuesday". It applies to the counts as well as the list, the
  // same way the search and the shop do.
  if (day) parts.push(raw`b.ship_ref >= ${ts(day.from)} AND b.ship_ref < ${ts(day.until)}`);

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
  const sameStatusCutoff = workingDayCutoff(at, 3);
  // Madrid midnight, the same boundary the cleanup uses — not `now` minus
  // 30 × 86,400,000, which drifts through the day and would put a parcel in
  // this tab that the cleanup will not touch.
  const staleBefore = cutoffFor(at);
  const where = predicates(cutoff, sameStatusCutoff, staleBefore);
  const day = parseDayFilter(opts.date);
  const extra = filters(q, store, day);

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
      SELECT b.*, count(*) OVER () AS total_rows
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
    rows: raws.map((r) => toRow(r, at, cutoff, sameStatusCutoff, staleBefore)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    stores: rowsOf<{ name: string }>(storeResult).map((s) => s.name),
  };
}

/**
 * Most urgent first, per tab.
 *
 * The post-office tabs go by LONGEST AT THE OFFICE — the earliest arrival
 * first — which is what "most urgent" means now that nothing claims to know
 * when a parcel goes back. The stuck tabs go oldest-first because the oldest
 * is the worst; and everything else goes by the last thing that happened, so
 * the list reads as "what moved recently".
 */
function orderFor(tab: ParcelTabId): SQL {
  if (tab === 'at_office') return raw`b.office_arrived_at ASC NULLS LAST, b.order_created_at ASC`;
  if (tab === 'missed_delivery') return raw`b.office_arrived_at ASC NULLS LAST`;
  if (tab === 'stuck_pre_admission' || tab === 'stuck_same_status' || tab === 'stuck_30') {
    return raw`b.ship_ref ASC`;
  }
  if (tab === 'closed') return raw`b.dropped_at DESC NULLS LAST`;
  return raw`b.state_since DESC NULLS LAST, b.order_created_at DESC`;
}

/* ----------------------------------------------------------------- mapping */

interface RawParcelRow {
  id: string;
  state: string;
  state_since: string | null;
  office_arrived_at: string | null;
  dropped_at: string | null;
  close_reason: string | null;
  close_note: string | null;
  shipment_created_at: string;
  shipping_code: string;
  order_number: string;
  customer_name: string;
  total_value_cents: number;
  payment_method: 'prepaid' | 'cod';
  phone_e164: string | null;
  email: string | null;
  city: string | null;
  placed_at: string | null;
  order_created_at: string;
  store_name: string;
  store_platform: string;
  shop_domain: string | null;
  external_order_id: string;
  office_name: string | null;
  office_address: string | null;
  office_hours: string | null;
  pre_ref: string;
  ship_ref: string;
  status_ref: string;
  has_order_date: boolean;
  failed_attempts: number | string | null;
  missed_delivery: boolean;
  event_desc: string | null;
  mapped_state: string | null;
  occurred_at: string | null;
  needs_review: boolean;
  total_rows: number | string;
}

function toRow(
  r: RawParcelRow, at: Date, cutoff: Date, sameStatusCutoff: Date, staleBefore: Date,
): ParcelListRow {
  const stateSince = r.state_since ? new Date(r.state_since) : new Date(r.shipment_created_at);
  const statusRef = new Date(r.status_ref);
  const preRef = new Date(r.pre_ref);
  const shipRef = new Date(r.ship_ref);
  const occurredAt = r.occurred_at ? new Date(r.occurred_at) : null;

  const daysInStatus = Math.max(0, madridDaysBetween(stateSince, at));
  const finished = ['delivered', 'collected', 'returned'].includes(r.state) || r.dropped_at !== null;

  const badges: string[] = [];

  // Every badge travels with the row, not with the tab. Finding a stuck parcel
  // under "All not finished" and not being told it is stuck would make the
  // badge a property of where you looked rather than of the parcel.
  if (r.state === 'created' && preRef.getTime() < cutoff.getTime()) {
    const n = workingDaysSince(preRef, at);
    badges.push(`${n} working ${n === 1 ? 'day' : 'days'} in pre-admission`);
  }

  if (SAME_STATUS_STATES.includes(r.state) && r.dropped_at === null
    && statusRef.getTime() < sameStatusCutoff.getTime()) {
    const n = workingDaysSince(statusRef, at);
    badges.push(`${n} working ${n === 1 ? 'day' : 'days'} in the same status`);
  }

  if (!finished && shipRef.getTime() < staleBefore.getTime()) {
    const n = madridDaysBetween(shipRef, at);
    badges.push(`${n} days, still not finished`);
  }

  const arrivedAt = r.office_arrived_at ? new Date(r.office_arrived_at) : null;
  const officeDays = r.state === 'at_office' ? daysAtOffice(arrivedAt, at) : null;

  /*
   * The same `officeDetails` text the parcel page copies, built here so the
   * contact tab needs nothing the list query did not already fetch. One
   * source for the wording: a second copy would drift, and the whole point of
   * build-message.ts is that every word a customer reads lives in one file.
   */
  const viaMarketplace = isMarketplace(r.store_platform);
  const messageText = officeDetails({
    firstName: realFirstName(r.customer_name),
    viaMarketplace,
    storeName: r.store_name,
    orderNumber: r.order_number,
    shippingCode: r.shipping_code,
    officeName: r.office_name,
    officeAddress: r.office_address,
    // Correos' own hours or none at all. The hard-coded fallback this used to
    // pass told customers opening times nobody had checked.
    officeHours: r.office_hours,
    officeArrivedAt: arrivedAt,
    daysAtOffice: officeDays,
    actionUrl: null,
  });

  return {
    id: r.id,
    state: r.state,
    status: stateLabels(r.state),
    orderNumber: r.order_number,
    shippingCode: r.shipping_code,
    // The label, not the raw column: the marketplace files carry no name, so
    // the database stores '' and the screens say which marketplace it was.
    customerName: customerLabel({
      customerName: r.customer_name,
      orderNumber: r.order_number,
      platform: r.store_platform,
    }),
    storeName: r.store_name,
    storePlatform: r.store_platform,
    orderedOn: r.placed_at ? shortDate(new Date(r.placed_at)) : null,
    shippedOn: shortDate(shipRef),
    shippedExact: exact(shipRef),
    event: occurredAt && r.event_desc
      ? {
        ...eventLabels(r.mapped_state, r.event_desc),
        when: `${shortDate(occurredAt)} · ${exact(occurredAt).split(', ')[1] ?? ''}`,
        exactWhen: exact(occurredAt),
      }
      : null,
    inStatus: daysInStatus === 0 ? 'today' : `${daysInStatus} ${daysInStatus === 1 ? 'day' : 'days'}`,
    daysInStatus,
    atOffice: arrivedAt && officeDays !== null
      ? {
        since: shortDate(arrivedAt),
        sinceExact: exact(arrivedAt),
        days: officeDays,
        late: officeDays >= OFFICE_CRIT_DAYS,
      }
      : null,
    paymentMethod: r.payment_method,
    valueText: money(r.total_value_cents),
    phoneDisplay: displayPhone(r.phone_e164),
    phoneE164: r.phone_e164,
    email: r.email,
    town: r.city ?? '',
    attempts: Number(r.failed_attempts ?? 0),
    officeName: r.office_name,
    officeAddress: r.office_address,
    mapsHref: mapsLink(r.office_name, r.office_address),
    messageText,
    waHref: r.phone_e164 ? whatsappLink(r.phone_e164, messageText) : '',
    emailHref: r.email
      ? emailLink(r.email, officeEmailSubject(r.order_number), messageText)
      : '',
    shopifyHref: shopifyOrderLink(r.store_platform, r.shop_domain, r.external_order_id) ?? '',
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
