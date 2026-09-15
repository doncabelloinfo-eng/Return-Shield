import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { escalationFires, notifications, shipments, tasks } from '@/db/schema';
import { TestClock, resetClock, DAY, HOUR, MINUTE } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runShipment } from '@/lib/escalation/run';
import { liveShipmentIds } from '@/lib/shipments/repo';
import { setSetting } from '@/lib/settings';
import { logCall } from '@/lib/escalation/outcomes';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The whole ladder, from a failed delivery to the parcel going back, driven
 * forward by the injectable clock. Fifteen days of business in well under a
 * second — which is the only reason anybody will ever run this before shipping
 * a change to the engine.
 */

let clock: TestClock;
let restore: () => void;

beforeEach(async () => {
  await resetDb();
  // 10:00 Madrid: inside the hours the system is allowed to message people.
  // Starting at 08:00 would have every message held until nine, which is
  // correct behaviour and makes for a confusing test.
  clock = new TestClock('2026-09-01T10:00:00+02:00');
  restore = clock.install();
  // Step 2, so the ladder sends messages itself and the test can count them.
  await setSetting('phase', 2);
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

async function push(shippingCode: string, desc: string, at: Date, office?: string) {
  return ingestEvent({
    shippingCode,
    eventCode: `EV-${desc.slice(0, 12)}`,
    eventDesc: desc,
    occurredAt: at,
    source: 'push',
    officeCode: office ?? null,
    officeName: office ? 'Oficina Madrid Sucursal 12' : null,
    rawPayload: { desEvento: desc },
  });
}

const openTasks = (id: string) =>
  getDb().select().from(tasks).where(and(eq(tasks.shipmentId, id), eq(tasks.status, 'open')));

const sentMessages = (id: string) =>
  getDb().select().from(notifications).where(eq(notifications.shipmentId, id));

describe('the ladder, from a failed delivery to a return', () => {
  it('walks every rung in order, on the day each is due', async () => {
    const f = await makeShipment({ depositDays: 15, valueCents: 14850, paymentMethod: 'cod' });

    // The postman calls and nobody is home.
    await push(f.shippingCode, 'Intento de entrega fallido — ausente', clock.now());
    let ship = (await getDb().select().from(shipments).where(eq(shipments.id, f.shipmentId)))[0];
    expect(ship.state).toBe('failed');

    // Nothing fires in the first quarter of an hour.
    clock.advanceMinutes(10);
    await runShipment(f.shipmentId, clock.now());
    expect(await sentMessages(f.shipmentId)).toHaveLength(0);

    // +15 minutes: the first message.
    clock.advanceMinutes(10);
    await runShipment(f.shipmentId, clock.now());
    let msgs = await sentMessages(f.shipmentId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].template).toBe('failed_first');
    expect(msgs[0].body).toContain('no había nadie');

    // +4 hours: the reminder.
    clock.advanceHours(4);
    await runShipment(f.shipmentId, clock.now());
    msgs = await sentMessages(f.shipmentId);
    expect(msgs.map((m) => m.template)).toEqual(['failed_first', 'failed_reminder']);

    // +24 hours: nobody has replied, so a person has to ring them.
    clock.advanceHours(20);
    await runShipment(f.shipmentId, clock.now());
    expect((await openTasks(f.shipmentId)).some((t) => t.type === 'call')).toBe(true);

    // Correos moves it to the counter. The countdown starts from their event,
    // never from our arithmetic.
    const arrived = clock.advanceHours(24);
    await push(f.shippingCode, 'Disponible en oficina para recoger', arrived, f.officeCode);
    ship = (await getDb().select().from(shipments).where(eq(shipments.id, f.shipmentId)))[0];
    expect(ship.state).toBe('at_office');
    expect(ship.officeDeadline).not.toBeNull();

    // The office details go out straight away, with the real last day in them.
    await runShipment(f.shipmentId, clock.now());
    msgs = await sentMessages(f.shipmentId);
    const details = msgs.find((m) => m.template === 'office_details');
    expect(details).toBeDefined();
    expect(details!.body).toContain('Oficina Madrid Sucursal 12');
    expect(details!.body).toContain(f.shippingCode);

    // Then each rung on its own day, counted back from the deadline.
    const seen = async () => (await sentMessages(f.shipmentId)).map((m) => m.template);

    clock.advanceDays(3); // 12 days left
    await runShipment(f.shipmentId, clock.now());
    expect(await seen()).toContain('office_reminder');

    clock.advanceDays(4); // 8 days left
    await runShipment(f.shipmentId, clock.now());
    expect(await seen()).toContain('office_elsewhere');

    clock.advanceDays(4); // 4 days left
    await runShipment(f.shipmentId, clock.now());
    expect(await seen()).toContain('office_four_days');

    clock.advanceDays(2); // 2 days left — last warning plus a call
    await runShipment(f.shipmentId, clock.now());
    expect(await seen()).toContain('office_last_call');
    const mustCall = (await openTasks(f.shipmentId)).find((t) => t.type === 'call');
    expect(mustCall?.label).toContain('Must call');
    expect(mustCall?.label).toContain('cash on delivery');

    // Out of time. The system flags it and tells somebody — it does not
    // invent a Correos event that never happened.
    clock.advanceDays(2);
    await runShipment(f.shipmentId, clock.now());
    const fired = await getDb().select().from(escalationFires)
      .where(eq(escalationFires.shipmentId, f.shipmentId));
    expect(fired.map((x) => x.rungId)).toContain('o0');
    expect((await openTasks(f.shipmentId)).some((t) => t.reason === 'deposit_window_over')).toBe(true);

    // And when Correos does say it is coming back, everything stops and the
    // only job left is the stock.
    await push(f.shippingCode, 'Devolución a origen iniciada', clock.now());
    ship = (await getDb().select().from(shipments).where(eq(shipments.id, f.shipmentId)))[0];
    expect(ship.state).toBe('returning');
    const finalTasks = await openTasks(f.shipmentId);
    expect(finalTasks.map((t) => t.type)).toContain('receive_return');
    expect(finalTasks.some((t) => t.type === 'contact')).toBe(false);
  });

  it('runs the whole fifteen days in one sweep after an outage', async () => {
    const f = await makeShipment({ depositDays: 15 });
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);

    // The worker was down for a fortnight. Every rung is due at once, and they
    // must fire in order rather than the last one winning.
    clock.advanceDays(14);
    await runShipment(f.shipmentId, clock.now());

    const templates = (await sentMessages(f.shipmentId)).map((m) => m.template);
    expect(templates).toEqual([
      'office_details', 'office_reminder', 'office_elsewhere',
      'office_four_days', 'office_last_call',
    ]);
  });

  it('goes quiet the moment the parcel is collected', async () => {
    const f = await makeShipment();
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);
    await runShipment(f.shipmentId, clock.now());
    expect((await sentMessages(f.shipmentId)).length).toBe(1);

    await push(f.shippingCode, 'Entregado en oficina', clock.advanceDays(1));

    // Two weeks later, still nothing. Silence means silence.
    clock.advanceDays(14);
    await runShipment(f.shipmentId, clock.now());
    expect((await sentMessages(f.shipmentId)).length).toBe(1);
    expect(await openTasks(f.shipmentId)).toHaveLength(0);
  });

  it('goes quiet the moment it is delivered', async () => {
    const f = await makeShipment();
    await push(f.shippingCode, 'Intento de entrega fallido — ausente', clock.now());
    clock.advanceMinutes(20);
    await runShipment(f.shipmentId, clock.now());
    expect((await sentMessages(f.shipmentId)).length).toBe(1);

    await push(f.shippingCode, 'Entregado', clock.advanceHours(2));
    clock.advanceDays(10);
    await runShipment(f.shipmentId, clock.now());
    expect((await sentMessages(f.shipmentId)).length).toBe(1);
  });

  it('finishes a shipment so it drops out of the live sweep', async () => {
    const f = await makeShipment();
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);
    expect(await liveShipmentIds()).toContain(f.shipmentId);

    await push(f.shippingCode, 'Entregado en oficina', clock.advanceDays(1));
    expect(await liveShipmentIds()).not.toContain(f.shipmentId);
  });
});

describe('call outcomes set their own follow-up', () => {
  it('"will pick it up" goes quiet for three days, then checks by itself', async () => {
    const f = await makeShipment();
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);
    await runShipment(f.shipmentId, clock.now());

    await logCall(f.shipmentId, 'Will pick it up', 'said they would go Saturday');

    // Quiet. No reminders while we wait.
    const before = (await sentMessages(f.shipmentId)).length;
    clock.advanceDays(2);
    await runShipment(f.shipmentId, clock.now());
    expect((await sentMessages(f.shipmentId)).length).toBe(before);
    expect(await openTasks(f.shipmentId)).toHaveLength(0);

    // Three days on, the system checks whether it actually happened.
    clock.advanceDays(1);
    await runShipment(f.shipmentId, clock.now());
    const call = (await openTasks(f.shipmentId)).find((t) => t.type === 'call');
    expect(call?.label).toBe('Said they would pick it up, still not collected');
  });

  it('"didn\'t pick up" brings them back tomorrow, same time', async () => {
    const f = await makeShipment();
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);
    await runShipment(f.shipmentId, clock.now());

    await logCall(f.shipmentId, "Didn't pick up", '');
    expect((await openTasks(f.shipmentId)).some((t) => t.type === 'call')).toBe(false);

    clock.advanceDays(1);
    await runShipment(f.shipmentId, clock.now());
    const call = (await openTasks(f.shipmentId)).find((t) => t.type === 'call');
    expect(call?.label).toBe('Try again — no answer yesterday');
  });

  it('"wants new address" stops the countdown messages and asks for Correos', async () => {
    const f = await makeShipment();
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);
    await runShipment(f.shipmentId, clock.now());
    const before = (await sentMessages(f.shipmentId)).length;

    await logCall(f.shipmentId, 'Wants new address', 'works away all week');

    clock.advanceDays(8);
    await runShipment(f.shipmentId, clock.now());
    expect((await sentMessages(f.shipmentId)).length).toBe(before);

    const [ship] = await getDb().select().from(shipments).where(eq(shipments.id, f.shipmentId));
    expect(ship.redirectPending).toBe(true);
    expect((await openTasks(f.shipmentId)).some((t) => t.type === 'address_fix')).toBe(true);
  });

  it('"doesn\'t want it" stops everything and readies the return', async () => {
    const f = await makeShipment();
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);
    await runShipment(f.shipmentId, clock.now());
    const before = (await sentMessages(f.shipmentId)).length;

    await logCall(f.shipmentId, "Doesn't want it", 'ordered by mistake');

    clock.advanceDays(20);
    await runShipment(f.shipmentId, clock.now());
    expect((await sentMessages(f.shipmentId)).length).toBe(before);
    expect((await openTasks(f.shipmentId)).map((t) => t.type)).toContain('receive_return');
  });

  it('keeps the last warning armed when somebody only promised to collect it', async () => {
    // A promise is not a collection. The rungs that matter must survive it.
    const f = await makeShipment({ depositDays: 15 });
    await push(f.shippingCode, 'Disponible en oficina para recoger', clock.now(), f.officeCode);
    await runShipment(f.shipmentId, clock.now());
    await logCall(f.shipmentId, 'Will pick it up', '');

    clock.advanceDays(13);
    await runShipment(f.shipmentId, clock.now());

    const templates = (await sentMessages(f.shipmentId)).map((m) => m.template);
    expect(templates).toContain('office_last_call');
  });
});
