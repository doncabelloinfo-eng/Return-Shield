import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { productRules, shipments } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { recalculateDeadlines } from '@/lib/shipments/repo';
import { deadlineFrom, daysLeft, madridDaysBetween, madridDateKey } from '@/lib/time';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The one number everything hangs off. Fifteen is a guess until somebody
 * confirms it with Correos, so changing it must move every deadline, every
 * countdown and every reminder — immediately, and without a deploy.
 */

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-09-01T10:00:00+02:00');
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

const shipmentRow = async (id: string) =>
  (await db.select().from(shipments).where(eq(shipments.id, id)))[0];

describe('the office deadline', () => {
  it('is arrival plus the product rule, never a hardcoded fifteen', async () => {
    const f = await makeShipment({ productCode: 'PAQ 48', depositDays: 7 });
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-05',
      eventDesc: 'Disponible en oficina para recoger',
      occurredAt: new Date('2026-09-01T11:00:00+02:00'),
      source: 'push', officeCode: f.officeCode, rawPayload: {},
    });

    const ship = await shipmentRow(f.shipmentId);
    // Arrived on the 1st, held seven days: the last day is the 8th.
    expect(madridDateKey(ship.officeDeadline!)).toBe('2026-09-08');
  });

  it('is the end of the last day, not the hour it happened to arrive', async () => {
    // A parcel that reached the counter at 13:47 does not go back at 13:47 a
    // fortnight later. Treating the deadline as an instant would warn people a
    // day early and write off parcels that are still collectable.
    const f = await makeShipment({ depositDays: 15 });
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-05',
      eventDesc: 'Disponible en oficina para recoger',
      occurredAt: new Date('2026-09-01T13:47:00+02:00'),
      source: 'push', officeCode: f.officeCode, rawPayload: {},
    });

    const ship = await shipmentRow(f.shipmentId);
    expect(madridDateKey(ship.officeDeadline!)).toBe('2026-09-16');
    // Still one day left at ten to midnight on the last day.
    expect(daysLeft(ship.officeDeadline!, new Date('2026-09-16T23:50:00+02:00'))).toBe(0);
    expect(daysLeft(ship.officeDeadline!, new Date('2026-09-15T23:50:00+02:00'))).toBe(1);
  });

  it('moves every live parcel when the number changes', async () => {
    const a = await makeShipment({ shippingCode: 'PQ1000000001ES', depositDays: 15 });
    const b = await makeShipment({ shippingCode: 'PQ1000000002ES', depositDays: 15 });

    for (const f of [a, b]) {
      await ingestEvent({
        shippingCode: f.shippingCode, eventCode: 'E-05',
        eventDesc: 'Disponible en oficina para recoger',
        occurredAt: new Date('2026-09-01T11:00:00+02:00'),
        source: 'push', officeCode: f.officeCode, rawPayload: {},
      });
    }

    expect(madridDateKey((await shipmentRow(a.shipmentId)).officeDeadline!)).toBe('2026-09-16');

    // Correos says it is seven days after all.
    await db.update(productRules).set({ depositDays: 7 })
      .where(eq(productRules.productCode, 'PAQ ESTÁNDAR'));
    await recalculateDeadlines('PAQ ESTÁNDAR');

    expect(madridDateKey((await shipmentRow(a.shipmentId)).officeDeadline!)).toBe('2026-09-08');
    expect(madridDateKey((await shipmentRow(b.shipmentId)).officeDeadline!)).toBe('2026-09-08');
  });

  it('can put a parcel past its last day straight away, as real life does', async () => {
    const f = await makeShipment({ depositDays: 15 });
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-05',
      eventDesc: 'Disponible en oficina para recoger',
      occurredAt: new Date('2026-09-01T11:00:00+02:00'),
      source: 'push', officeCode: f.officeCode, rawPayload: {},
    });

    clock.set('2026-09-10T10:00:00+02:00');
    expect(daysLeft((await shipmentRow(f.shipmentId)).officeDeadline!)).toBe(6);

    await db.update(productRules).set({ depositDays: 5 })
      .where(eq(productRules.productCode, 'PAQ ESTÁNDAR'));
    await recalculateDeadlines('PAQ ESTÁNDAR');

    // Out of time the moment the setting changed.
    expect(daysLeft((await shipmentRow(f.shipmentId)).officeDeadline!)).toBe(-4);
  });

  it('stops counting once the parcel has left the office', async () => {
    const f = await makeShipment();
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-05', eventDesc: 'Disponible en oficina para recoger',
      occurredAt: new Date('2026-09-01T11:00:00+02:00'), source: 'push', officeCode: f.officeCode, rawPayload: {},
    });
    expect((await shipmentRow(f.shipmentId)).officeDeadline).not.toBeNull();

    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-06', eventDesc: 'Entregado en oficina',
      occurredAt: new Date('2026-09-03T11:00:00+02:00'), source: 'push', rawPayload: {},
    });
    expect((await shipmentRow(f.shipmentId)).officeDeadline).toBeNull();
  });
});

describe('Madrid days, not blocks of 86,400 seconds', () => {
  it('counts the night the clocks go back as one day', async () => {
    // 25 October 2026, Spain goes from summer to winter time. That day is 25
    // hours long; counting in milliseconds would lose an hour and eventually a
    // whole day off somebody's deadline.
    const before = new Date('2026-10-24T12:00:00+02:00');
    const after = new Date('2026-10-25T12:00:00+01:00');
    expect(madridDaysBetween(before, after)).toBe(1);
  });

  it('counts the night the clocks go forward as one day', async () => {
    const before = new Date('2027-03-27T12:00:00+01:00');
    const after = new Date('2027-03-28T12:00:00+02:00');
    expect(madridDaysBetween(before, after)).toBe(1);
  });

  it('lands on the right calendar day across a clock change', () => {
    const arrived = new Date('2026-10-20T16:00:00+02:00');
    const deadline = deadlineFrom(arrived, 15);
    expect(madridDateKey(deadline)).toBe('2026-11-04');
  });

  it('treats a deadline late tonight as today, not as zero point four days', () => {
    const deadline = new Date('2026-09-16T23:59:59.999+02:00');
    expect(daysLeft(deadline, new Date('2026-09-16T09:00:00+02:00'))).toBe(0);
  });
});
