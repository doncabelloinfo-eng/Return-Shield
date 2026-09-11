import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { contactLog, offices, orders, shipments } from '@/db/schema';
import { now, DAY } from '@/lib/clock';
import { say } from '@/lib/activity';
import { human } from '@/lib/time';
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

  await db.insert(contactLog).values({
    shipmentId, at, outcome, note: note.trim(), userId: userId ?? null,
  });

  switch (outcome) {
    case 'Will pick it up': {
      // Quiet for three days, then the system checks it actually happened.
      // The last warning and the return alert stay armed: a promise is not a
      // collection, and this is exactly the case where one gets forgotten.
      const until = new Date(at.getTime() + 3 * DAY);
      await db.update(shipments).set({
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
      await db.update(shipments).set({
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
      await db.update(shipments).set({ reacted: true, mutedUntil: null, snoozeReason: null })
        .where(eq(shipments.id, shipmentId));
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId, ['call', 'contact'], { outcome, note });
      await db.update(orders).set({ repeatRisk: true }).where(eq(orders.id, ctx.orderId));
      await openTask({
        shipmentId, type: 'receive_return', reason: 'customer_refused_on_call',
        label: 'Put back in stock when it lands',
      });
      await say(`${ctx.name} — doesn't want it, ${money(ctx.valueCents)} lost, ready to go back in stock`, shipmentId);
      const { sendInternalAlert } = await import('@/lib/mail/send');
      await sendInternalAlert({
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

  await db.insert(contactLog).values({
    shipmentId, at: now(), outcome: 'Customer replied', note: label,
  });

  await db.update(shipments).set({ reacted: true }).where(eq(shipments.id, shipmentId));
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
      await db.update(shipments).set({ redirectPending: true }).where(eq(shipments.id, shipmentId));
      break;
    case 'cant_go':
      await db.update(shipments).set({ redirectPending: true }).where(eq(shipments.id, shipmentId));
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
  await db.update(shipments).set({ restockedAt: now() }).where(eq(shipments.id, shipmentId));
  await closeTasks(shipmentId, ['receive_return', 'address_fix', 'chase_carrier'], { outcome: 'Back in stock', userId });
  await say(`${ctx.name} — ${ctx.orderNumber} back in stock, closed itself`, shipmentId);
  return { toast: `${ctx.orderNumber} back in stock.` };
}

export async function undoRestock(shipmentId: string): Promise<void> {
  await db.update(shipments).set({ restockedAt: null }).where(eq(shipments.id, shipmentId));
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
  await db.update(shipments).set({ redirectPending: false }).where(eq(shipments.id, shipmentId));
  await closeTasks(shipmentId, ['address_fix'], { outcome: 'New address sent to Correos', userId });
  await db.insert(contactLog).values({
    shipmentId, at: now(), outcome: 'New address sent to Correos', note: '', userId: userId ?? null,
  });
  await say(`${ctx.name} — new address sent to Correos (they charge for this one)`, shipmentId);
  return { toast: 'New address sent to Correos.' };
}

/** "Stop chasing this one". Writes off the parcel. Confirmed, and undoable. */
export async function dropIt(shipmentId: string, userId?: string): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  await db.update(shipments).set({ droppedAt: now() }).where(eq(shipments.id, shipmentId));
  await silence(shipmentId, { keepFinal: false });
  await closeTasks(shipmentId, undefined, { outcome: 'Stopped chasing', userId });
  await say(`${ctx.name} — we stop chasing this one`, shipmentId);
  return { toast: `Stopped chasing ${ctx.orderNumber}.` };
}

export async function undoDrop(shipmentId: string): Promise<void> {
  await db.update(shipments).set({ droppedAt: null }).where(eq(shipments.id, shipmentId));
}

/** "Ask Correos about this one" / "Fix address with Correos". */
export async function askCorreos(shipmentId: string, userId?: string): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  await closeTasks(shipmentId, ['chase_carrier', 'address_fix'], { outcome: 'Asked Correos', userId });
  await db.insert(contactLog).values({
    shipmentId, at: now(), outcome: 'Asked Correos', note: '', userId: userId ?? null,
  });
  await say(`${ctx.name} — asked Correos what happened to ${ctx.shippingCode}`, shipmentId);
  return { toast: `Asked Correos about ${ctx.shippingCode}.` };
}

/** "Confirm the address now" — the before-anything-went-wrong action. */
export async function confirmAddress(shipmentId: string, userId?: string): Promise<OutcomeResult> {
  const ctx = await context(shipmentId);
  await closeTasks(shipmentId, ['insight', 'address_fix'], { outcome: 'Address confirmed', userId });
  await db.insert(contactLog).values({
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
  shippingCode: string;
  valueCents: number;
  paymentMethod: 'prepaid' | 'cod';
  officeName: string | null;
}

async function context(shipmentId: string): Promise<Ctx> {
  const [row] = await db.select({
    name: orders.customerName,
    orderId: orders.id,
    orderNumber: orders.orderNumber,
    shippingCode: shipments.shippingCode,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    officeName: offices.name,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  if (!row) throw new Error(`outcomes: no shipment ${shipmentId}`);
  return row;
}

export { firstName };
