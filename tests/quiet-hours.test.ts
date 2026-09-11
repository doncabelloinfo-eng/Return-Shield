import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { activity, notifications, tasks } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runShipment } from '@/lib/escalation/run';
import { setSetting } from '@/lib/settings';
import { withinSendingHours, nextSendingSlot } from '@/lib/escalation/ladder';
import { madridParts } from '@/lib/time';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The prototype's clock jumped in whole days and never landed at 04:00. A real
 * one does, every single night.
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

const msgs = (id: string) => db.select().from(notifications).where(eq(notifications.shipmentId, id));
const openTasks = (id: string) =>
  db.select().from(tasks).where(and(eq(tasks.shipmentId, id), eq(tasks.status, 'open')));

describe('sending hours', () => {
  it('is nine in the morning to nine at night, Madrid time', () => {
    expect(withinSendingHours(new Date('2026-09-01T08:59:00+02:00'))).toBe(false);
    expect(withinSendingHours(new Date('2026-09-01T09:00:00+02:00'))).toBe(true);
    expect(withinSendingHours(new Date('2026-09-01T20:59:00+02:00'))).toBe(true);
    expect(withinSendingHours(new Date('2026-09-01T21:00:00+02:00'))).toBe(false);
    expect(withinSendingHours(new Date('2026-09-01T04:00:00+02:00'))).toBe(false);
  });

  it('pushes a late-night moment to nine the next morning', () => {
    const slot = nextSendingSlot(new Date('2026-09-01T23:30:00+02:00'));
    const p = madridParts(slot);
    expect(p.day).toBe(2);
    expect(p.hour).toBe(9);
  });

  it('pushes an early-morning moment to nine the same day', () => {
    const slot = nextSendingSlot(new Date('2026-09-02T04:00:00+02:00'));
    const p = madridParts(slot);
    expect(p.day).toBe(2);
    expect(p.hour).toBe(9);
  });
});

describe('a message that comes due in the middle of the night', () => {
  it('is held until the morning rather than sent at four', async () => {
    const f = await makeShipment();
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-05', eventDesc: 'Disponible en oficina para recoger',
      occurredAt: clock.now(), source: 'push', officeCode: f.officeCode, rawPayload: {},
    });

    clock.set('2026-09-02T04:00:00+02:00');
    await runShipment(f.shipmentId, clock.now());
    expect(await msgs(f.shipmentId)).toHaveLength(0);

    clock.set('2026-09-02T09:05:00+02:00');
    await runShipment(f.shipmentId, clock.now());
    expect(await msgs(f.shipmentId)).toHaveLength(1);
  });

  it('does not spin: one held rung leaves the others alone', async () => {
    // Before the fix, a deferred rung was re-read forty times a tick and every
    // later rung was starved behind it.
    const f = await makeShipment({ depositDays: 15 });
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-04', eventDesc: 'Intento de entrega fallido — ausente',
      occurredAt: clock.now(), source: 'push', rawPayload: {},
    });

    clock.set('2026-09-03T03:00:00+02:00');
    const r = await runShipment(f.shipmentId, clock.now());

    // The messages waited; the call task that was due did not.
    expect(await msgs(f.shipmentId)).toHaveLength(0);
    expect((await openTasks(f.shipmentId)).some((t) => t.type === 'call')).toBe(true);
    expect(r.rungsFired).toBeGreaterThan(0);
  });
});

describe('the last warning at two days left', () => {
  it('books the call even when the message itself has to wait for morning', async () => {
    // The call is not a message. Holding it back until nine on the
    // second-to-last day is the delay that loses the parcel.
    const f = await makeShipment({ depositDays: 15, paymentMethod: 'cod', valueCents: 14850 });
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-05', eventDesc: 'Disponible en oficina para recoger',
      occurredAt: clock.now(), source: 'push', officeCode: f.officeCode, rawPayload: {},
    });

    clock.set('2026-09-14T23:30:00+02:00');
    await runShipment(f.shipmentId, clock.now());

    const call = (await openTasks(f.shipmentId)).find((t) => t.type === 'call');
    expect(call?.label).toContain('Must call');
    expect(call?.label).toContain('cash on delivery');
    expect(await msgs(f.shipmentId)).toHaveLength(0);
  });

  it('says so once, not on every tick until morning', async () => {
    const f = await makeShipment({ depositDays: 15 });
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-05', eventDesc: 'Disponible en oficina para recoger',
      occurredAt: clock.now(), source: 'push', officeCode: f.officeCode, rawPayload: {},
    });

    clock.set('2026-09-14T23:00:00+02:00');
    for (let i = 0; i < 6; i += 1) {
      clock.advanceMinutes(30);
      if (madridParts(clock.now()).hour < 9) await runShipment(f.shipmentId, clock.now());
    }

    const lines = await db.select().from(activity);
    const lastWarning = lines.filter((l) => l.text.includes('a call you cannot skip'));
    expect(lastWarning).toHaveLength(1);
  });
});
