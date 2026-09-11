import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { eventReviewQueue, notifications, shipmentEvents, shipments, tasks } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runShipment } from '@/lib/escalation/run';
import { setSetting } from '@/lib/settings';
import { normalisePayload } from '@/lib/carriers/correos/normalise';
import { resetDb, closeDb } from './helpers/db';
import { correosPush, makeShipment } from './helpers/fixtures';

/**
 * The thing that makes push and polling able to coexist.
 *
 * Without it, every nightly sweep would re-fire the whole escalation ladder at
 * customers who already heard from us — which is not a bug you find in
 * staging, it is a bug you find when somebody gets six identical WhatsApps.
 */

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-09-01T10:00:00+02:00');
  clock.install();
  await setSetting('phase', 2);
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

const events = (id: string) => db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, id));
const msgs = (id: string) => db.select().from(notifications).where(eq(notifications.shipmentId, id));

describe('the same event arriving twice changes nothing the second time', () => {
  it('stores one row and sends one message however many times it is replayed', async () => {
    const f = await makeShipment();
    const at = clock.now();

    const event = {
      shippingCode: f.shippingCode,
      eventCode: 'E-1130',
      eventDesc: 'Disponible en oficina para recoger',
      occurredAt: at,
      source: 'push' as const,
      officeCode: f.officeCode,
      officeName: 'Oficina Madrid Sucursal 12',
      rawPayload: { desEvento: 'Disponible en oficina para recoger' },
    };

    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(await ingestEvent(event));
      await runShipment(f.shipmentId, clock.now());
    }

    expect(results[0].status).toBe('inserted');
    expect(results.slice(1).every((r) => r.status === 'duplicate')).toBe(true);

    expect(await events(f.shipmentId)).toHaveLength(1);
    expect(await msgs(f.shipmentId)).toHaveLength(1);
  });

  it('treats a poll of an event that already arrived by push as a duplicate', async () => {
    const f = await makeShipment();
    const at = clock.now();

    const pushed = await ingestEvent({
      shippingCode: f.shippingCode,
      eventCode: 'E-1130',
      eventDesc: 'Disponible en oficina para recoger',
      occurredAt: at,
      source: 'push',
      officeCode: f.officeCode,
      rawPayload: {},
    });
    await runShipment(f.shipmentId, clock.now());

    // The nightly sweep finds the same event. Different source, same event.
    const polled = await ingestEvent({
      shippingCode: f.shippingCode,
      eventCode: 'E-1130',
      eventDesc: 'Disponible en oficina para recoger',
      occurredAt: at,
      source: 'poll',
      officeCode: f.officeCode,
      rawPayload: {},
    });
    await runShipment(f.shipmentId, clock.now());

    expect(pushed.status).toBe('inserted');
    expect(polled.status).toBe('duplicate');
    expect(await events(f.shipmentId)).toHaveLength(1);
    expect(await msgs(f.shipmentId)).toHaveLength(1);
  });

  it('replaying a whole tracking history re-sends nothing', async () => {
    const f = await makeShipment();
    const payload = correosPush(f.shippingCode, [
      { code: 'E-01', desc: 'Admitido', date: '01/09/2026', time: '09:00' },
      { code: 'E-02', desc: 'En tránsito', date: '01/09/2026', time: '19:00' },
      { code: 'E-03', desc: 'En reparto', date: '02/09/2026', time: '08:00' },
      { code: 'E-04', desc: 'Intento de entrega fallido — ausente', date: '02/09/2026', time: '13:00' },
      { code: 'E-05', desc: 'Disponible en oficina para recoger', date: '02/09/2026', time: '19:00', office: f.officeCode },
    ]);

    // The events are dated the 1st and 2nd; stand on the 3rd so the office
    // rungs that are already due can actually fire.
    clock.set('2026-09-03T10:00:00+02:00');

    const ingestAll = async (source: 'push' | 'poll') => {
      const { events: list } = normalisePayload(payload, source);
      for (const e of list) await ingestEvent(e);
      await runShipment(f.shipmentId, clock.now());
    };

    await ingestAll('push');
    const afterFirst = (await msgs(f.shipmentId)).length;
    expect(await events(f.shipmentId)).toHaveLength(5);
    expect(afterFirst).toBeGreaterThan(0);

    // The nightly reconcile pulls the same five events, three nights running.
    await ingestAll('poll');
    await ingestAll('poll');
    await ingestAll('poll');

    expect(await events(f.shipmentId)).toHaveLength(5);
    expect((await msgs(f.shipmentId)).length).toBe(afterFirst);
  });

  it('two different events at the same second are both kept', async () => {
    // The dedupe key is (shipment, code, moment) — not (shipment, moment).
    // Correos stamps several scans to the same minute and losing one of them
    // would lose the state change.
    const f = await makeShipment();
    const at = clock.now();

    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-A', eventDesc: 'En reparto',
      occurredAt: at, source: 'push', rawPayload: {},
    });
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-B', eventDesc: 'Intento de entrega fallido — ausente',
      occurredAt: at, source: 'push', rawPayload: {},
    });

    expect(await events(f.shipmentId)).toHaveLength(2);
  });
});

describe('an event Correos has never sent before', () => {
  it('is kept, queued for review, and breaks nothing', async () => {
    const f = await makeShipment();

    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-9999',
      eventDesc: 'Envío retenido en aduana por inspección aleatoria',
      occurredAt: clock.now(), source: 'push', rawPayload: { anything: true },
    });

    const rows = await events(f.shipmentId);
    expect(rows).toHaveLength(1);
    // Their words are kept exactly as they arrived, for the timeline.
    expect(rows[0].eventDesc).toBe('Envío retenido en aduana por inspección aleatoria');
    // And it changed nothing.
    expect(rows[0].mappedState).toBeNull();

    const [ship] = await db.select().from(shipments).where(eq(shipments.id, f.shipmentId));
    expect(ship.state).toBe('created');

    const review = await db.select().from(eventReviewQueue);
    expect(review).toHaveLength(1);
    expect(review[0].eventCode).toBe('E-9999');
  });

  it('counts how many times it has been seen rather than piling up rows', async () => {
    const f = await makeShipment();
    for (let i = 0; i < 3; i += 1) {
      await ingestEvent({
        shippingCode: f.shippingCode, eventCode: 'E-9999', eventDesc: 'Algo que no conocemos',
        occurredAt: new Date(clock.now().getTime() + i * 60_000), source: 'push', rawPayload: {},
      });
    }
    const review = await db.select().from(eventReviewQueue);
    expect(review).toHaveLength(1);
    expect(review[0].timesSeen).toBe(3);
  });

  it('does not stop the mapped events in the same payload from working', async () => {
    const f = await makeShipment();
    const payload = correosPush(f.shippingCode, [
      { code: 'E-99', desc: 'Un evento que no conocemos', date: '02/09/2026', time: '08:00' },
      { code: 'E-05', desc: 'Disponible en oficina para recoger', date: '02/09/2026', time: '09:00', office: f.officeCode },
    ]);

    const { events: list } = normalisePayload(payload, 'push');
    for (const e of list) await ingestEvent(e);

    const [ship] = await db.select().from(shipments).where(eq(shipments.id, f.shipmentId));
    expect(ship.state).toBe('at_office');
    expect(ship.officeDeadline).not.toBeNull();
  });
});

describe('an event for a parcel we have never heard of', () => {
  it('is reported, not thrown', async () => {
    const r = await ingestEvent({
      shippingCode: 'PQ0000000000ES', eventCode: 'E-01', eventDesc: 'Admitido',
      occurredAt: clock.now(), source: 'push', rawPayload: {},
    });
    expect(r.status).toBe('unknown_shipment');
  });
});

describe('tasks do not pile up', () => {
  it('opening the same kind of task twice leaves one open task', async () => {
    const f = await makeShipment();
    const { openTask } = await import('@/lib/escalation/tasks');

    await openTask({ shipmentId: f.shipmentId, type: 'call', reason: 'a', label: 'Call them' });
    await openTask({ shipmentId: f.shipmentId, type: 'call', reason: 'b', label: 'Call them again' });

    const rows = await db.select().from(tasks).where(eq(tasks.shipmentId, f.shipmentId));
    expect(rows).toHaveLength(1);
    // The newest reason wins rather than sitting alongside the old one.
    expect(rows[0].label).toBe('Call them again');
  });
});
