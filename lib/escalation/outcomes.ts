import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { closures, contactLog, offices, orders, shipments, stores } from '@/db/schema';
import { now, DAY } from '@/lib/clock';
import { say } from '@/lib/activity';
import { human, madridDaysBetween } from '@/lib/time';
import {
  CLOSE_REASONS, isCloseReason, noteRequiredFor, type CloseReason,
} from './close-reasons';
import { firstName, money } from './decide';
import { closeTasks, openTask } from './tasks';
import { scheduleExtra, silence } from './silence';

/**
 * What happens after a call, and after a customer taps something on their own
 * page. Each outcome sets its own follow-up — that is the whole point. Filing
 * a call must never leave a parcel with nothing scheduled, because a parcel
 * with nothing scheduled is a parcel that goes back.
 */

export { CALL_OUTCOMES, isCallOutcome } from './outcome-names';
export { CLOSE_REASONS, isCloseReason, closeReasonLabel, noteRequiredFor } from './close-reasons';
export type { CloseReason };
import type { CallOutcome } from './outcome-names';
export type { CallOutcome };

export interface OutcomeResult {
  /** The line under the toast. Says what the system will now do, and when. */
  toast: string;
}

export async function logCall(
  shipmentId: string,
  outcome: CallOutcome,
  note: string,
  userId?: string,
): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  const at = now();

  await getDb().insert(contactLog).values({
    shipmentId, at, outcome, note: note.trim(), userId: userId ?? null,
  });

  switch (outcome) {
    case 'Will pick it up': {
      // Quiet for three days, then the system checks it actually happened.
      // The last warning and the return alert stay armed: a promise is not a
      // collection, and this is exactly the case where one gets forgotten.
      const until = new Date(at.getTime() + 3 * DAY);
      await getDb().update(shipments).set({
        reacted: true, mutedUntil: until, snoozeReason: 'Said they would pick it up',
      }).where(eq(shipments.id, shipmentId));
      await silence(shipmentId, { keepFinal: true });
      await closeTasks(shipmentId, ['call', 'contact'], { outcome, note });
      await scheduleExtra(shipmentId, 'recheck', until);
      await say(
        `${ctx.name} — will pick it up, quiet for 3 days, then the system checks it actually happened`,
        shipmentId,
      );
      return { toast: `Filed. Quiet until ${human(until, at)}, then it checks by itself.` };
    }

    case 'Wants new address': {
      await getDb().update(shipments).set({
        reacted: true, redirectPending: true, mutedUntil: null, snoozeReason: null,
      }).where(eq(shipments.id, shipmentId));
      await silence(shipmentId, { keepFinal: true });
      await closeTasks(shipmentId, ['call', 'contact'], { outcome, note });
      await openTask({
        shipmentId, type: 'address_fix', reason: 'customer_wants_redirect',
        label: 'Send new address to Correos',
      });
      await say(
        `${ctx.name} — wants it somewhere else, countdown messages stopped, on your list to sort with Correos`,
        shipmentId,
      );
      return { toast: 'Filed. Reminders stopped — Correos still needs the new address.' };
    }

    case "Didn't pick up": {
      // Back tomorrow, same time. Not silenced: nothing has been resolved.
      await closeTasks(shipmentId, ['call'], { outcome, note });
      await scheduleExtra(shipmentId, 'retry', new Date(at.getTime() + DAY));
      await say(`${ctx.name} — didn't pick up, the system will bring them back tomorrow`, shipmentId);
      return { toast: 'Filed. Back on your list tomorrow, same time.' };
    }

    case "Doesn't want it": {
      await getDb().update(shipments).set({ reacted: true, mutedUntil: null, snoozeReason: null })
        .where(eq(shipments.id, shipmentId));
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId, ['call', 'contact'], { outcome, note });
      await getDb().update(orders).set({ repeatRisk: true }).where(eq(orders.id, ctx.orderId));
      await openTask({
        shipmentId, type: 'receive_return', reason: 'customer_refused_on_call',
        label: 'Put back in stock when it lands',
      });
      await say(`${ctx.name} — doesn't want it, ${money(ctx.valueCents)} lost, ready to go back in stock`, shipmentId);
      const { raiseAlert } = await import('@/lib/alerts');
      await raiseAlert({
        // Keyed on the call, not just the parcel: an operator who rings again
        // tomorrow and hears the same thing is telling us something new.
        dedupeKey: `refused:${shipmentId}:${at.toISOString()}`,
        shipmentId,
        subject: `Customer refused: ${ctx.orderNumber} · ${ctx.name} · ${money(ctx.valueCents)}`,
        lines: [
          `${ctx.name} told us on the phone they do not want ${ctx.orderNumber}.`,
          note ? `They said: "${note.trim()}"` : '',
          '',
          `Value: ${money(ctx.valueCents)} (${ctx.paymentMethod === 'cod' ? 'cash on delivery' : 'prepaid — refund due'})`,
          'Reminders are stopped. It is on the list to put back in stock.',
        ].filter(Boolean),
      });
      return { toast: 'Filed. Reminders stopped, ready to go back in stock.' };
    }
  }
}

/* -------------------------------------------------------------------------- */

export const CUSTOMER_ACTIONS = {
  ok_address: 'Mi dirección es correcta',
  change_address: 'Quiero cambiar la dirección',
  cant_go: 'No puedo ir, reenviadlo',
  call_me: 'Llamadme',
} as const;

export type CustomerAction = keyof typeof CUSTOMER_ACTIONS;

export function isCustomerAction(x: string): x is CustomerAction {
  return x in CUSTOMER_ACTIONS;
}

/**
 * The customer tapped something. The countdown messages stop immediately —
 * somebody who has just told us what they want should not get a reminder an
 * hour later — and exactly one thing lands on an operator's list.
 */
export async function applyCustomerAction(shipmentId: string, action: CustomerAction): Promise<void> {
  const ctx = await context(shipmentId);
  const label = CUSTOMER_ACTIONS[action];

  await getDb().insert(contactLog).values({
    shipmentId, at: now(), outcome: 'Customer replied', note: label,
  });

  await getDb().update(shipments).set({ reacted: true }).where(eq(shipments.id, shipmentId));
  await closeTasks(shipmentId, ['contact', 'call']);
  await silence(shipmentId, { keepFinal: true });

  switch (action) {
    case 'ok_address':
      await openTask({
        shipmentId, type: 'address_fix', reason: 'address_confirmed',
        label: 'Address is right — book another delivery',
      });
      break;
    case 'change_address':
      await openTask({
        shipmentId, type: 'address_fix', reason: 'customer_wants_redirect',
        label: 'Send new address to Correos',
      });
      await getDb().update(shipments).set({ redirectPending: true }).where(eq(shipments.id, shipmentId));
      break;
    case 'cant_go':
      await getDb().update(shipments).set({ redirectPending: true }).where(eq(shipments.id, shipmentId));
      await openTask({
        shipmentId, type: 'address_fix', reason: 'customer_cannot_collect',
        label: 'Send new address to Correos',
      });
      break;
    case 'call_me':
      await openTask({
        shipmentId, type: 'call', reason: 'customer_asked_for_call',
        label: 'Asked us to call them back',
      });
      break;
  }

  await say(
    `${ctx.name} — tapped "${label}" on their phone — messages stopped, one thing on your list`,
    shipmentId,
  );
}

/* -------------------------------------------------------------------------- */

/** "Put back in stock". The parcel physically came back. */
export async function restock(shipmentId: string, userId?: string): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  await getDb().update(shipments).set({ restockedAt: now() }).where(eq(shipments.id, shipmentId));
  await closeTasks(shipmentId, ['receive_return', 'address_fix', 'chase_carrier'], { outcome: 'Back in stock', userId });
  await say(`${ctx.name} — ${ctx.orderNumber} back in stock, closed itself`, shipmentId);
  return { toast: `${ctx.orderNumber} back in stock.` };
}

export async function undoRestock(shipmentId: string): Promise<void> {
  await getDb().update(shipments).set({ restockedAt: null }).where(eq(shipments.id, shipmentId));
  await openTask({
    shipmentId, type: 'receive_return', reason: 'returning', label: 'Put back in stock',
  });
}

/**
 * "Send to a new address". Correos charges for a redirection, so this one is
 * behind the tap-again confirmation and is never automated.
 */
export async function sendRedirect(shipmentId: string, userId?: string): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  await getDb().update(shipments).set({ redirectPending: false }).where(eq(shipments.id, shipmentId));
  await closeTasks(shipmentId, ['address_fix'], { outcome: 'New address sent to Correos', userId });
  await getDb().insert(contactLog).values({
    shipmentId, at: now(), outcome: 'New address sent to Correos', note: '', userId: userId ?? null,
  });
  await say(`${ctx.name} — new address marked as sent to Correos`, shipmentId);
  return { toast: 'Noted — the new address is marked as sent to Correos.' };
}

/**
 * "Stop chasing this one". Writes off the parcel. Confirmed, and undoable.
 *
 * THE REASON IS REQUIRED, and that is the whole change. This used to write a
 * timestamp and nothing else, so a month later the system could say how many
 * parcels had been given up on and never why — a parcel Correos lost and a
 * parcel the customer had all along were the same row. Now it can answer "how
 * many did we lose last quarter, and to what", which is the question somebody
 * actually asks.
 *
 * It writes two things. The shipment carries the reason so every screen can
 * show it, and `closures` carries a copy that survives the parcel: the rolling
 * thirty-day window deletes the order and cascades through everything attached
 * to it, and a record of a write-off that vanishes after a month is not a
 * record.
 */
export async function dropIt(
  shipmentId: string,
  close: { reason: CloseReason; note?: string },
  userId?: string,
): Promise<OutcomeResult> {
  if (!isCloseReason(close.reason)) {
    throw new Error(`close: "${close.reason}" is not one of ${Object.keys(CLOSE_REASONS).join(', ')}`);
  }

  const note = (close.note ?? '').trim();
  // "Other" with no note is the one combination that records nothing at all,
  // which defeats the point of asking.
  if (noteRequiredFor(close.reason) && !note) {
    throw new Error('close: "Other" needs a note saying what happened');
  }

  const ctx = await context(shipmentId);
  const at = now();

  await getDb().update(shipments).set({
    droppedAt: at,
    closeReason: close.reason,
    closeNote: note,
    closedBy: userId ?? null,
  }).where(eq(shipments.id, shipmentId));

  await getDb().insert(closures).values({
    shipmentId,
    orderNumber: ctx.orderNumber,
    storeName: ctx.storeName,
    shippingCode: ctx.shippingCode,
    reason: close.reason,
    note,
    valueCents: ctx.valueCents,
    daysSinceOrder: Math.max(0, madridDaysBetween(ctx.orderCreatedAt, at)),
    closedAt: at,
    closedBy: userId ?? null,
  });

  await silence(shipmentId, { keepFinal: false });
  await closeTasks(shipmentId, undefined, { outcome: 'Stopped chasing', userId });

  const label = CLOSE_REASONS[close.reason].label;
  await say(
    `${ctx.name} — we stop chasing ${ctx.orderNumber}: ${label.toLowerCase()}`
    + `${note ? ` ("${note}")` : ''}`,
    shipmentId,
  );

  return { toast: `Stopped chasing ${ctx.orderNumber} — ${label}.` };
}

/**
 * Undo. Marks the closure undone rather than deleting it.
 *
 * Deleting would be simpler and would lose the one fact worth keeping: that
 * somebody wrote a parcel off and then changed their mind. Every count
 * excludes undone rows, so nothing is overstated — but the trail is there when
 * a pattern of write-offs that get reversed is itself the thing to notice.
 */
export async function undoDrop(shipmentId: string): Promise<void> {
  const at = now();

  await getDb().update(shipments).set({
    droppedAt: null, closeReason: null, closeNote: null, closedBy: null,
  }).where(eq(shipments.id, shipmentId));

  await getDb().update(closures).set({ undoneAt: at })
    .where(and(eq(closures.shipmentId, shipmentId), isNull(closures.undoneAt)));
}

/** "Ask Correos about this one" / "Fix address with Correos". */
export async function askCorreos(shipmentId: string, userId?: string): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  await closeTasks(shipmentId, ['chase_carrier', 'address_fix'], { outcome: 'Asked Correos', userId });
  await getDb().insert(contactLog).values({
    shipmentId, at: now(), outcome: 'Asked Correos', note: '', userId: userId ?? null,
  });
  await say(`${ctx.name} — marked as asked Correos about ${ctx.shippingCode}`, shipmentId);
  return { toast: `Noted — ${ctx.shippingCode} is marked as asked.` };
}

/** "Confirm the address now" — the before-anything-went-wrong action. */
export async function confirmAddress(shipmentId: string, userId?: string): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  await closeTasks(shipmentId, ['insight', 'address_fix'], { outcome: 'Address confirmed', userId });
  await getDb().insert(contactLog).values({
    shipmentId, at: now(), outcome: 'Address confirmed', note: '', userId: userId ?? null,
  });
  await say(`${ctx.name} — address confirmed before dispatch, one failed delivery avoided`, shipmentId);
  return { toast: 'Address confirmed.' };
}

/* -------------------------------------------------------------------------- */

interface Ctx {
  name: string;
  orderId: string;
  orderNumber: string;
  orderCreatedAt: Date;
  shippingCode: string;
  storeName: string;
  valueCents: number;
  paymentMethod: 'prepaid' | 'cod';
  officeName: string | null;
}

async function context(shipmentId: string): Promise<Ctx> {
  const [row] = await getDb().select({
    name: orders.customerName,
    orderId: orders.id,
    orderNumber: orders.orderNumber,
    orderCreatedAt: orders.createdAt,
    shippingCode: shipments.shippingCode,
    storeName: stores.name,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    officeName: offices.name,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  if (!row) throw new Error(`outcomes: no shipment ${shipmentId}`);
  return row;
}

export { firstName };
