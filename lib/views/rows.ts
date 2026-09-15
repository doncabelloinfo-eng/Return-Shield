import { and, desc, eq, gte, inArray, sql as raw } from 'drizzle-orm';
import { getDb } from '@/db';
import { contactLog, offices, orders, shipments, stores, tasks } from '@/db/schema';
import type { ShipmentState } from '@/lib/state-machine/states';
import {
  actionable, callQueue, isSnoozed, money, nextAction, priority, reason, tone,
  type DecidableShipment, type NextAction, type OpenTask, type Tone,
} from '@/lib/escalation/decide';
import { daysLeft, exact, human } from '@/lib/time';
import { now } from '@/lib/clock';
import { mapsLink, officeDetails, telLink, whatsappLink, DEFAULT_OFFICE_HOURS } from '@/lib/messaging/build-message';
import { firstName } from '@/lib/escalation/decide';
import { displayPhone } from '@/lib/import/phone';

/**
 * One shape for every list on every screen.
 *
 * The screens do no arithmetic and take no decisions — they render what this
 * file worked out. That is what keeps "no screen shows raw data where the
 * system could have reached the conclusion itself" true as screens get added.
 */

export interface ShipmentRow extends DecidableShipment {
  shippingCode: string;
  orderNumber: string;
  storeName: string;
  phoneE164: string | null;
  phoneDisplay: string;
  phoneStatus: string;
  email: string | null;
  addressLine: string | null;
  officeAddress: string | null;
  officeHours: string | null;
  lastEventAt: Date | null;
  snoozeReason: string | null;

  /* --- worked out, so a screen never has to --- */
  /** The big number: days left, or ↩ when it is already coming back. */
  countdown: string;
  countdownTone: Tone;
  /** "goes back this Thursday" / "last update yesterday". */
  when: string;
  /** The full timestamp, for the title attribute. */
  exactWhen: string;
  valueText: string;
  action: NextAction | null;
  /** The sentence under the row. */
  why: string;
  /** "Top of the list: 2 days left · €148.50, cash on delivery." */
  topReason: string;
  snoozed: boolean;
  daysLeftNumber: number | null;
  telHref: string;
  waHref: string;
  mapsHref: string;
  /** The finished Spanish message, ready to copy. */
  messageText: string;
  lastContactLine: string;
}

export async function loadRows(opts: { at?: Date } = {}): Promise<ShipmentRow[]> {
  const at = opts.at ?? now();

  const rows = await getDb().select({
    id: shipments.id,
    state: shipments.state,
    shippingCode: shipments.shippingCode,
    officeDeadline: shipments.officeDeadline,
    lastEventAt: shipments.lastEventAt,
    mutedUntil: shipments.mutedUntil,
    snoozeReason: shipments.snoozeReason,
    droppedAt: shipments.droppedAt,
    restockedAt: shipments.restockedAt,
    redirectPending: shipments.redirectPending,
    orderNumber: orders.orderNumber,
    customerName: orders.customerName,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    phoneE164: orders.phoneE164,
    phoneStatus: orders.phoneStatus,
    email: orders.email,
    addressLine: orders.addressLine,
    city: orders.city,
    postalCode: orders.postalCode,
    storeName: stores.name,
    officeName: offices.name,
    officeAddress: offices.address,
    officeHours: offices.openingHours,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .leftJoin(offices, eq(offices.id, shipments.officeId));

  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const [taskRows, lastContacts] = await Promise.all([
    getDb().select().from(tasks).where(and(inArray(tasks.shipmentId, ids), eq(tasks.status, 'open'))),
    lastContactByShipment(ids),
  ]);

  const tasksBy = new Map<string, OpenTask[]>();
  for (const t of taskRows) {
    const list = tasksBy.get(t.shipmentId) ?? [];
    list.push({ type: t.type, reason: t.reason, label: t.label });
    tasksBy.set(t.shipmentId, list);
  }

  return rows.map((r) => {
    const last = lastContacts.get(r.id) ?? null;
    const base: DecidableShipment = {
      id: r.id,
      state: r.state as ShipmentState,
      officeDeadline: r.officeDeadline,
      officeName: r.officeName,
      town: r.city ?? '',
      customerName: r.customerName,
      valueCents: r.valueCents,
      paymentMethod: r.paymentMethod,
      dropped: r.droppedAt !== null,
      restocked: r.restockedAt !== null,
      redirectPending: r.redirectPending,
      mutedUntil: r.mutedUntil,
      openTasks: tasksBy.get(r.id) ?? [],
      lastContactOutcome: last?.outcome ?? null,
    };

    const action = nextAction(base, at);
    const d = daysLeft(r.officeDeadline, at);
    const snoozed = isSnoozed(base, at);
    const coming = r.state === 'returning' || r.state === 'refused' || r.state === 'returned';

    const messageText = officeDetails({
      firstName: firstName(r.customerName),
      storeName: r.storeName,
      orderNumber: r.orderNumber,
      shippingCode: r.shippingCode,
      officeName: r.officeName,
      officeAddress: r.officeAddress,
      officeHours: r.officeHours ?? DEFAULT_OFFICE_HOURS,
      deadline: r.officeDeadline,
      actionUrl: null,
    });

    return {
      ...base,
      shippingCode: r.shippingCode,
      orderNumber: r.orderNumber,
      storeName: r.storeName,
      phoneE164: r.phoneE164,
      phoneDisplay: displayPhone(r.phoneE164),
      phoneStatus: r.phoneStatus,
      email: r.email,
      addressLine: [r.addressLine, r.postalCode, r.city].filter(Boolean).join(' · ') || null,
      officeAddress: r.officeAddress,
      officeHours: r.officeHours,
      lastEventAt: r.lastEventAt,
      snoozeReason: r.snoozeReason,

      countdown: coming ? '↩' : (d === null ? '–' : String(d)),
      countdownTone: tone(base.state, r.officeDeadline, at),
      when: r.officeDeadline && r.state === 'at_office'
        ? human(r.officeDeadline, at)
        : (r.lastEventAt ? `last update ${human(r.lastEventAt, at)}` : ''),
      exactWhen: r.officeDeadline ? exact(r.officeDeadline) : (r.lastEventAt ? exact(r.lastEventAt) : ''),
      valueText: money(r.valueCents),
      action,
      why: snoozed
        ? `Quiet until ${human(r.mutedUntil!, at)}`
        : (action ? action.why : 'Nothing to do'),
      topReason: reason(base, at),
      snoozed,
      daysLeftNumber: d,
      telHref: r.phoneE164 ? telLink(r.phoneE164) : '',
      waHref: r.phoneE164 ? whatsappLink(r.phoneE164, messageText) : '',
      mapsHref: mapsLink(r.officeName, r.officeAddress),
      messageText,
      lastContactLine: last
        ? `Last time: ${last.outcome} ${human(last.at, at)}${last.note ? ` — "${last.note}"` : ''}`
        : 'Never contacted',
    } satisfies ShipmentRow;
  });
}

async function lastContactByShipment(ids: readonly string[]) {
  const rows = await getDb().select({
    shipmentId: contactLog.shipmentId,
    at: contactLog.at,
    outcome: contactLog.outcome,
    note: contactLog.note,
  })
    .from(contactLog)
    .where(inArray(contactLog.shipmentId, ids as string[]))
    .orderBy(desc(contactLog.at));

  const out = new Map<string, { at: Date; outcome: string; note: string }>();
  for (const r of rows) if (!out.has(r.shipmentId)) out.set(r.shipmentId, r);
  return out;
}

/* -------------------------------------------------------------------------- */

export interface TodayView {
  rows: ShipmentRow[];
  headline: string;
  digest: string[];
  focus: ShipmentRow | null;
  comingBack: ShipmentRow[];
  doneToday: number;
  totalToday: number;
  progressLabel: string;
  callCount: number;
}

/** Everything the Today screen needs, already decided. */
export async function todayView(focusIndex = 0, at: Date = now()): Promise<TodayView> {
  const all = await loadRows({ at });
  const act = actionable(all, at);
  const calls = callQueue(all, at);
  const comingBack = all.filter((r) =>
    (r.state === 'returning' || r.state === 'refused' || r.state === 'returned')
    && !r.restocked && !r.dropped);

  const doneToday = await countDoneToday(at);

  const digest: string[] = [];
  if (calls.length) {
    const names = calls.slice(0, 3).map((s) =>
      `${firstName(s.customerName)} (${s.daysLeftNumber !== null ? `${s.daysLeftNumber} days left, ` : ''}`
      + `${s.valueText}${s.paymentMethod === 'cod' ? ' cash on delivery' : ''})`).join(', ');
    digest.push(
      `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}: ${names}`
      + (calls.length > 3 ? ` and ${calls.length - 3} more` : ''),
    );
  }
  if (comingBack.length) {
    const total = comingBack.reduce((a, s) => a + s.valueCents, 0);
    digest.push(`${comingBack.length} parcels coming back — ${money(total)} to put back in stock.`);
  }
  const other = act.length - calls.length - comingBack.length;
  if (other > 0) digest.push(`${other} other thing${other === 1 ? '' : 's'} need${other === 1 ? 's' : ''} you.`);
  if (!act.length) digest.push('Nothing else needs you.');

  const totalToday = doneToday + act.length;

  return {
    rows: act,
    headline: act.length
      ? `${calls.length ? `${calls.length} ${calls.length === 1 ? 'call' : 'calls'}` : 'No calls'}`
        + ` and ${Math.max(0, act.length - calls.length)} other thing`
        + `${act.length - calls.length === 1 ? '' : 's'} need you today.`
      : 'Nothing needs you today.',
    digest,
    focus: act.length ? act[focusIndex % act.length] : null,
    comingBack,
    doneToday,
    totalToday,
    progressLabel: totalToday ? `${doneToday} of ${totalToday} done today` : 'nothing owed today',
    callCount: calls.length,
  };
}

/** Tasks closed since midnight in Madrid. The progress bar's numerator. */
async function countDoneToday(at: Date): Promise<number> {
  const { madridMidnightUtc, madridParts } = await import('@/lib/time');
  const p = madridParts(at);
  const midnight = madridMidnightUtc(p.year, p.month, p.day);
  // gte() rather than a raw fragment: drizzle then knows the column's type and
  // hands the driver a timestamp, instead of a bare Date it cannot serialise.
  const [row] = await getDb().select({ n: raw<number>`count(*)::int` }).from(tasks)
    .where(and(eq(tasks.status, 'done'), gte(tasks.closedAt, midnight)));
  return row?.n ?? 0;
}

export async function officeView(at: Date = now()): Promise<ShipmentRow[]> {
  const all = await loadRows({ at });
  return all
    .filter((r) => r.state === 'at_office' && !r.dropped)
    .sort((a, b) => (a.daysLeftNumber ?? 999) - (b.daysLeftNumber ?? 999));
}

export async function callsView(at: Date = now()): Promise<ShipmentRow[]> {
  return callQueue(await loadRows({ at }), at);
}

export { actionable, callQueue, priority, money, firstName };
