import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { notifications, offices, orders, shipments, stores } from '@/db/schema';
import { now, DAY } from '@/lib/clock';
import { say } from '@/lib/activity';
import { getSettings } from '@/lib/settings';
import { ladderInput } from '@/lib/shipments/repo';
import { ingestEvent } from '@/lib/shipments/ingest';
import { buildMessage, DEFAULT_OFFICE_HOURS, messageProvider } from '@/lib/messaging';
import type { MessageContext } from '@/lib/messaging/types';
import { firstName, money } from './decide';
import { dueRungs, nextSendingSlot, withinSendingHours, type DueRung } from './ladder';
import { markFired, scheduleExtra } from './silence';
import { openTask } from './tasks';
import { mintActionToken } from '@/lib/action-token';
import { daysLeft } from '@/lib/time';

/**
 * The part that actually does things. Everything it decides comes from the
 * pure ladder; everything it writes is idempotent, because this runs every
 * thirty minutes and will one day run twice at once.
 */

export interface TickResult {
  shipmentsWalked: number;
  rungsFired: number;
  messagesWritten: number;
  messagesSent: number;
  tasksOpened: number;
}

/** Walk one shipment and fire whatever is due. */
export async function runShipment(shipmentId: string, at: Date = now()): Promise<TickResult> {
  const result: TickResult = { shipmentsWalked: 1, rungsFired: 0, messagesWritten: 0, messagesSent: 0, tasksOpened: 0 };

  // Rungs are fired oldest first and re-read between each one: firing o8 can
  // change what o4 should do, and after an outage several are due at once.
  //
  // A rung the engine cannot act on yet — a message due at four in the morning
  // — is set aside rather than retried, so the night's ticks do not spin on it
  // forty times a shipment while achieving nothing.
  const deferred = new Set<string>();

  for (let guard = 0; guard < 40; guard += 1) {
    const input = await ladderInput(shipmentId);
    const rung = dueRungs(input, at).find((r) => !deferred.has(r.id));
    if (!rung) break;

    const outcome = await fireRung(shipmentId, rung, at, result);
    if (outcome === 'deferred') { deferred.add(rung.id); continue; }
    result.rungsFired += 1;
  }

  return result;
}

/** Walk every live shipment. The half-hourly tick. */
export async function runTick(ids: readonly string[], at: Date = now()): Promise<TickResult> {
  const total: TickResult = { shipmentsWalked: 0, rungsFired: 0, messagesWritten: 0, messagesSent: 0, tasksOpened: 0 };
  for (const id of ids) {
    const r = await runShipment(id, at);
    total.shipmentsWalked += r.shipmentsWalked;
    total.rungsFired += r.rungsFired;
    total.messagesWritten += r.messagesWritten;
    total.messagesSent += r.messagesSent;
    total.tasksOpened += r.tasksOpened;
  }
  return total;
}

/* -------------------------------------------------------------------------- */

type FireOutcome = 'fired' | 'deferred';

async function fireRung(
  shipmentId: string, rung: DueRung, at: Date, result: TickResult,
): Promise<FireOutcome> {
  const ctx = await messageContextFor(shipmentId);
  if (!ctx) { await markFired(shipmentId, rung.id); return 'fired'; }

  // The last warning is a message *and* a call nobody may skip. The call is
  // not a message, so it is booked whatever the hour — an operator is not
  // woken by a task appearing on a list, and holding it back until nine on the
  // second-to-last day is exactly the delay that loses the parcel.
  if (rung.id === 'o2') await bookLastWarningCall(shipmentId, ctx, result);

  switch (rung.effect.kind) {
    case 'message': {
      // A message due in the middle of the night waits until morning. The rung
      // is left unfired, so nothing is lost and nothing is sent at 04:00.
      if (!withinSendingHours(at)) return 'deferred';
      await markFired(shipmentId, rung.id);
      await deliverMessage(shipmentId, rung, ctx, result);
      break;
    }

    case 'call_task': {
      await markFired(shipmentId, rung.id);
      await openTask({
        shipmentId,
        type: 'call',
        reason: rung.effect.reason,
        label: rung.effect.label,
      });
      result.tasksOpened += 1;
      await say(callTaskLine(rung, ctx), shipmentId);
      break;
    }

    case 'chase_carrier': {
      await markFired(shipmentId, rung.id);
      await openTask({
        shipmentId, type: 'chase_carrier', reason: 'no_updates', label: rung.effect.label,
      });
      result.tasksOpened += 1;
      await say(`${ctx.customerName} — ${rung.effect.label}`, shipmentId);
      break;
    }

    case 'expect_at_office': {
      await markFired(shipmentId, rung.id);
      // Correos normally has it at the counter two days after a failed
      // delivery. We do NOT invent the event — if they have not said so, the
      // parcel is unaccounted for and that is worth a person looking.
      await openTask({
        shipmentId,
        type: 'chase_carrier',
        reason: 'expected_at_office',
        label: 'Two days since the missed delivery and Correos has not said it reached an office',
      });
      result.tasksOpened += 1;
      await say(
        `${ctx.customerName} — two days on and Correos still has not said it reached an office`,
        shipmentId,
      );
      break;
    }

    case 'deadline_reached': {
      await markFired(shipmentId, rung.id);
      await say(
        `${ctx.customerName} — time ran out at ${ctx.officeName ?? 'the post office'}, Correos should be sending it back`,
        shipmentId,
      );
      // Same rule as above: the deposit window running out is our arithmetic,
      // not Correos'. We flag it and tell somebody; we do not write a return
      // event that never happened.
      await openTask({
        shipmentId,
        type: 'chase_carrier',
        reason: 'deposit_window_over',
        label: 'The post office should have sent this back — confirm with Correos',
      });
      result.tasksOpened += 1;
      const { sendInternalAlert } = await import('@/lib/mail/send');
      await sendInternalAlert({
        subject: `About to be returned: ${ctx.orderNumber} · ${ctx.customerName} · ${money(ctx.valueCents)}`,
        lines: [
          `${ctx.orderNumber} has run out of time at ${ctx.officeName ?? 'the post office'}.`,
          '',
          `Customer: ${ctx.customerName}`,
          `Value:    ${money(ctx.valueCents)} (${ctx.paymentMethod === 'cod' ? 'cash on delivery' : 'prepaid'})`,
          `Tracking: ${ctx.shippingCode}`,
        ],
      });
      break;
    }
  }

  return 'fired';
}

async function bookLastWarningCall(
  shipmentId: string, ctx: MessageContextRow, result: TickResult,
): Promise<void> {
  const cod = ctx.paymentMethod === 'cod';

  const opened = await openTask({
    shipmentId,
    type: 'call',
    reason: 'last_warning',
    label: `Must call${cod ? ' · cash on delivery, we earn nothing if it comes back' : ''}`,
    priority: 100,
  });

  // Only announce it the first time. A message held overnight brings us back
  // here on every tick until morning, and the activity feed is worth nothing
  // if it repeats the same line two hundred times.
  if (opened === 'opened') {
    result.tasksOpened += 1;
    await say(
      `${ctx.customerName} — 2 days left${cod ? ` on ${money(ctx.valueCents)} cash on delivery` : ''}`
      + ', last warning and a call you cannot skip',
      shipmentId,
    );
  }
}

function callTaskLine(rung: DueRung, ctx: MessageContextRow): string {
  switch (rung.base) {
    case 'f24': return `${ctx.customerName} — a day since the missed delivery and no word back, on your call list`;
    case 'recheck': return `${ctx.customerName} — said they would go, still not collected, back at the top of your list`;
    case 'retry': return `${ctx.customerName} — no answer yesterday, try again today`;
    case 'nochk': return `${ctx.customerName} — a day on and no reply to the message, on your call list`;
    default: return `${ctx.customerName} — on your call list`;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Write the message, then either send it or put it in front of a person.
 *
 * Step 1 and Step 2 run the exact same ladder and produce the exact same text.
 * The only difference is the last line of this function.
 */
async function deliverMessage(
  shipmentId: string,
  rung: DueRung,
  ctx: MessageContextRow,
  result: TickResult,
): Promise<void> {
  if (rung.effect.kind !== 'message') return;

  const settings = await getSettings();
  const provider = messageProvider();
  const step2 = settings.phase === 2 && provider.canSend;

  const token = mintActionToken(shipmentId);
  const actionUrl = `${appUrl()}/e/${token}`;

  const built = buildMessage(rung.effect.template, {
    firstName: firstName(ctx.customerName),
    storeName: ctx.storeName,
    orderNumber: ctx.orderNumber,
    shippingCode: ctx.shippingCode,
    officeName: ctx.officeName,
    officeAddress: ctx.officeAddress,
    officeHours: ctx.officeHours ?? DEFAULT_OFFICE_HOURS,
    deadline: ctx.officeDeadline,
    actionUrl: step2 ? actionUrl : null,
  } satisfies MessageContext);

  const [row] = await db.insert(notifications).values({
    shipmentId,
    template: built.template,
    body: built.body,
    linkLabel: built.linkLabel,
    channel: 'whatsapp',
    status: 'queued',
    actionToken: token,
    // The link dies with the parcel or after thirty days, whichever is first.
    tokenExpiresAt: new Date(now().getTime() + 30 * DAY),
    createdAt: now(),
  }).returning({ id: notifications.id });

  result.messagesWritten += 1;

  if (!step2) {
    // Step 1: the system has written it, a person sends it.
    await openTask({
      shipmentId,
      type: 'contact',
      reason: rung.effect.template,
      label: ctx.officeDeadline ? 'Send the office details' : 'Get in touch, nobody was home',
    });
    result.tasksOpened += 1;
    await say(
      `${ctx.customerName} — message written for you, ready to copy (Step 1 sends nothing by itself)`,
      shipmentId,
    );
    return;
  }

  if (!ctx.phoneE164 || ctx.phoneStatus !== 'ok') {
    await db.update(notifications)
      .set({ status: 'failed', error: `cannot message a ${ctx.phoneStatus} number` })
      .where(eq(notifications.id, row.id));
    await openTask({
      shipmentId,
      type: 'call',
      reason: 'no_messageable_number',
      label: ctx.phoneStatus === 'landline'
        ? 'Landline only — no WhatsApp, call them'
        : 'No usable phone number — call or email them',
    });
    result.tasksOpened += 1;
    await say(`${ctx.customerName} — no number we can message, on your call list instead`, shipmentId);
    return;
  }

  const sent = await provider.send(ctx.phoneE164, built, actionUrl);
  await db.update(notifications).set({
    status: sent.status,
    sentAt: sent.status === 'sent' ? now() : null,
    providerMessageId: sent.providerMessageId,
    error: sent.error ?? null,
  }).where(eq(notifications.id, row.id));

  if (sent.status === 'sent') {
    result.messagesSent += 1;
    await say(`${ctx.customerName} — message sent by itself, waiting to hear back`, shipmentId);
    // If nobody answers within a day, a person picks up the phone.
    await scheduleExtra(shipmentId, 'nochk', new Date(now().getTime() + DAY));
  } else {
    await openTask({
      shipmentId, type: 'call', reason: 'message_failed',
      label: 'The message did not go out — call them',
    });
    result.tasksOpened += 1;
    await say(`${ctx.customerName} — the message did not go out, on your call list`, shipmentId);
  }
}

/* -------------------------------------------------------------------------- */

interface MessageContextRow {
  customerName: string;
  storeName: string;
  orderNumber: string;
  shippingCode: string;
  officeName: string | null;
  officeAddress: string | null;
  officeHours: string | null;
  officeDeadline: Date | null;
  phoneE164: string | null;
  phoneStatus: string;
  valueCents: number;
  paymentMethod: 'prepaid' | 'cod';
}

async function messageContextFor(shipmentId: string): Promise<MessageContextRow | null> {
  const [row] = await db.select({
    customerName: orders.customerName,
    storeName: stores.name,
    orderNumber: orders.orderNumber,
    shippingCode: shipments.shippingCode,
    officeName: offices.name,
    officeAddress: offices.address,
    officeHours: offices.openingHours,
    officeDeadline: shipments.officeDeadline,
    phoneE164: orders.phoneE164,
    phoneStatus: orders.phoneStatus,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  return row ?? null;
}

function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export { nextSendingSlot };
