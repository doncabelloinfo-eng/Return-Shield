import { and, eq, sql as raw } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  escalationFires, eventReviewQueue, offices, orders, shipmentEvents, shipments,
} from '@/db/schema';
import { mapCorreosEvent } from '@/lib/carriers/correos/state-map';
import type { ShipmentState } from '@/lib/state-machine/states';
import { RETURN_STATES } from '@/lib/state-machine/states';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';
import { money } from '@/lib/escalation/decide';
import { shortDate } from '@/lib/time';
import { openTask, closeTasks } from '@/lib/escalation/tasks';
import { silence } from '@/lib/escalation/silence';
import { reproject } from './repo';

/**
 * One event in. Push and the nightly poll both come through here.
 *
 * Writing the same event twice is not an error and is not a special case — the
 * UNIQUE(shipment_id, event_code, occurred_at) constraint makes the second
 * write a no-op, and because nothing downstream runs when nothing was
 * inserted, a customer who already heard from us does not hear from us again.
 * That one index is what lets push and polling coexist at all.
 */

export interface IncomingEvent {
  shippingCode: string;
  eventCode: string;
  eventDesc: string;
  occurredAt: Date;
  source: 'push' | 'poll' | 'system';
  officeCode?: string | null;
  officeName?: string | null;
  officeAddress?: string | null;
  rawPayload: unknown;
}

export interface IngestResult {
  status: 'inserted' | 'duplicate' | 'unknown_shipment';
  shipmentId?: string;
  mappedState?: ShipmentState | null;
  stateChanged?: boolean;
}

export async function ingestEvent(ev: IncomingEvent): Promise<IngestResult> {
  const [ship] = await getDb().select({ id: shipments.id, state: shipments.state })
    .from(shipments).where(eq(shipments.shippingCode, ev.shippingCode)).limit(1);

  if (!ship) {
    // A tracking code we have never seen. Correos pushes for everything the
    // account ships, including parcels created outside this system, so this is
    // routine — log it and move on rather than treating it as a failure.
    return { status: 'unknown_shipment' };
  }

  const mapped = mapCorreosEvent(ev.eventCode, ev.eventDesc);
  if (mapped === null) await queueForReview(ev);

  if (ev.officeCode) await upsertOffice(ev);

  const inserted = await getDb().insert(shipmentEvents).values({
    shipmentId: ship.id,
    rawPayload: ev.rawPayload as object,
    eventCode: ev.eventCode,
    eventDesc: ev.eventDesc,
    occurredAt: ev.occurredAt,
    receivedAt: now(),
    source: ev.source,
    mappedState: mapped,
    officeCode: ev.officeCode ?? null,
    officeName: ev.officeName ?? null,
  }).onConflictDoNothing({
    target: [shipmentEvents.shipmentId, shipmentEvents.eventCode, shipmentEvents.occurredAt],
  }).returning({ id: shipmentEvents.id });

  if (!inserted.length) {
    return { status: 'duplicate', shipmentId: ship.id, mappedState: mapped };
  }

  const before = ship.state as ShipmentState;
  const after = (await reproject(ship.id)).state;

  if (after !== before) await onStateEntered(ship.id, before, after);

  return { status: 'inserted', shipmentId: ship.id, mappedState: mapped, stateChanged: after !== before };
}

/**
 * Correos said something we have no mapping for. Keep it, count it, show it to
 * a human — and change nothing. An unknown code must never stop the parcels we
 * do understand from being chased.
 */
async function queueForReview(ev: IncomingEvent): Promise<void> {
  await getDb().insert(eventReviewQueue).values({
    eventCode: ev.eventCode,
    eventDesc: ev.eventDesc,
    samplePayload: ev.rawPayload as object,
    firstSeenAt: now(),
    lastSeenAt: now(),
  }).onConflictDoUpdate({
    target: [eventReviewQueue.eventCode, eventReviewQueue.eventDesc],
    set: { timesSeen: raw`${eventReviewQueue.timesSeen} + 1`, lastSeenAt: now() },
  });
}

async function upsertOffice(ev: IncomingEvent): Promise<void> {
  // An event often carries only the office code. Falling back to the code as
  // the name is fine for an office we have never seen, but it must never
  // overwrite a real name we already have — a customer sent to "OF-MAD-12"
  // instead of "Oficina Madrid Sucursal 12" cannot find the building.
  await getDb().insert(offices).values({
    correosCode: ev.officeCode!,
    name: ev.officeName ?? ev.officeCode!,
    address: ev.officeAddress ?? '',
    updatedAt: now(),
  }).onConflictDoUpdate({
    target: offices.correosCode,
    set: {
      name: ev.officeName
        ? raw`COALESCE(NULLIF(EXCLUDED.name, ''), ${offices.name})`
        : raw`${offices.name}`,
      address: ev.officeAddress
        ? raw`COALESCE(NULLIF(EXCLUDED.address, ''), ${offices.address})`
        : raw`${offices.address}`,
      updatedAt: now(),
    },
  });
}

/* -------------------------------------------------------------------------- */

/**
 * What entering a state means. This is the part of the engine that reacts to
 * Correos rather than to the clock.
 */
async function onStateEntered(shipmentId: string, from: ShipmentState, to: ShipmentState): Promise<void> {
  const detail = await getDb().select({
    customerName: orders.customerName,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    orderNumber: orders.orderNumber,
    postalCode: orders.postalCode,
    city: orders.city,
    orderId: orders.id,
    officeName: offices.name,
    deadline: shipments.officeDeadline,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  const d = detail[0];
  if (!d) return;

  const name = d.customerName;
  const office = d.officeName ?? 'the post office';

  // Any update from Correos answers the "we have heard nothing" question.
  await closeTasks(shipmentId, ['chase_carrier']);
  await getDb().delete(escalationFires).where(and(
    eq(escalationFires.shipmentId, shipmentId),
    eq(escalationFires.rungId, 'stale'),
  ));

  switch (to) {
    case 'failed': {
      // A fresh failure restarts the ladder: the four rungs below hang off
      // this failure, not the one a week ago.
      await getDb().delete(escalationFires).where(eq(escalationFires.shipmentId, shipmentId));
      await getDb().update(shipments)
        .set({ mutedUntil: null, snoozeReason: null, reacted: false, escalationStage: 'failed' })
        .where(eq(shipments.id, shipmentId));
      await say(`${name} — nobody home, reminders started`, shipmentId);
      break;
    }

    case 'at_office': {
      await getDb().update(shipments).set({ escalationStage: 'at_office' }).where(eq(shipments.id, shipmentId));
      const when = d.deadline ? `, last day ${shortDate(d.deadline)}` : '';
      await say(`${name} — now at ${office}${when}`, shipmentId);
      break;
    }

    case 'delivered': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId);
      await getDb().update(shipments).set({ mutedUntil: null, snoozeReason: null, escalationStage: null })
        .where(eq(shipments.id, shipmentId));
      await say(`${name} — delivered, closed itself`, shipmentId);
      break;
    }

    case 'collected': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId);
      await getDb().update(shipments).set({ mutedUntil: null, snoozeReason: null, escalationStage: null })
        .where(eq(shipments.id, shipmentId));
      await say(`${name} — picked it up, ${money(d.valueCents)} saved, closed itself`, shipmentId);
      break;
    }

    case 'bad_address': {
      await silence(shipmentId, { keepFinal: false });
      await openTask({
        shipmentId, type: 'address_fix', reason: 'carrier_says_wrong_address',
        label: 'Wrong address — fix it with Correos',
      });
      await say(`${name} — Correos says the address is wrong, on your list`, shipmentId);
      break;
    }

    case 'refused': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId, ['call', 'contact']);
      await markRepeatRisk(d.orderId);
      await openTask({
        shipmentId, type: 'receive_return', reason: 'refused', label: 'Put back in stock',
      });
      await say(`${name} — doesn't want it, ${money(d.valueCents)} lost, waiting to go back in stock`, shipmentId);
      break;
    }

    case 'returning':
    case 'returned': {
      await silence(shipmentId, { keepFinal: false });
      await closeTasks(shipmentId, ['call', 'contact']);
      await markRepeatRisk(d.orderId);
      await openTask({
        shipmentId, type: 'receive_return', reason: 'returning', label: 'Put back in stock',
      });
      const pay = d.paymentMethod === 'cod' ? 'Cash on delivery' : 'Prepaid';
      await say(
        `Coming back to us — ${d.orderNumber} · ${name} · ${money(d.valueCents)} · ${pay} · time ran out at ${office}`,
        shipmentId,
      );
      break;
    }

    case 'accepted': {
      // Before anything has gone wrong: is this a postcode that fails far more
      // than average? Preventing one failed delivery beats rescuing three.
      if (await isWatchedArea(d.postalCode)) {
        await openTask({
          shipmentId, type: 'insight', reason: 'area_fails_often',
          label: 'This area fails often — worth confirming the address now',
        });
        const town = (d.city ?? '').split(',')[0];
        await say(
          `${name} — ${town} fails far more than average, worth confirming the address before it goes out`,
          shipmentId,
        );
      }
      break;
    }

    default:
      break;
  }

  if (RETURN_STATES.has(to) && !RETURN_STATES.has(from)) {
    await notifyReturnStarted(shipmentId);
  }
}

async function markRepeatRisk(orderId: string): Promise<void> {
  await getDb().update(orders).set({ repeatRisk: true }).where(eq(orders.id, orderId));
}

async function isWatchedArea(postalCode: string | null): Promise<boolean> {
  if (!postalCode) return false;
  const { postcodeStats } = await import('@/db/schema');
  const [row] = await getDb().select({ watch: postcodeStats.watch }).from(postcodeStats)
    .where(eq(postcodeStats.postalCode, postalCode)).limit(1);
  return row?.watch ?? false;
}

/**
 * A return has started. Somebody internal needs to know now, with everything
 * they would otherwise have to go and look up.
 */
async function notifyReturnStarted(shipmentId: string): Promise<void> {
  const { sendInternalAlert } = await import('@/lib/mail/send');
  const row = await getDb().select({
    orderNumber: orders.orderNumber,
    customerName: orders.customerName,
    valueCents: orders.totalValueCents,
    paymentMethod: orders.paymentMethod,
    shippingCode: shipments.shippingCode,
    state: shipments.state,
    officeName: offices.name,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  const d = row[0];
  if (!d) return;

  const why = d.state === 'refused'
    ? 'the customer refused it at the door'
    : `nobody collected it from ${d.officeName ?? 'the post office'} in time`;

  await sendInternalAlert({
    subject: `Coming back: ${d.orderNumber} · ${d.customerName} · ${money(d.valueCents)}`,
    lines: [
      `Order ${d.orderNumber} is on its way back to us because ${why}.`,
      '',
      `Customer:  ${d.customerName}`,
      `Value:     ${money(d.valueCents)} (${d.paymentMethod === 'cod' ? 'cash on delivery — we earn nothing if it comes back' : 'prepaid — a refund is coming'})`,
      `Tracking:  ${d.shippingCode}`,
      '',
      'It is on the list to put back in stock when it lands.',
    ],
  });
}
