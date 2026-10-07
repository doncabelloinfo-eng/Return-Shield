import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipments } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { daysAtOffice, madridDaysBetween, madridDateKey } from '@/lib/time';
import { tone, priority, reason, type DecidableShipment } from '@/lib/escalation/decide';
import { loadRows, officeView } from '@/lib/views/rows';
import { parcelsView } from '@/lib/views/parcels';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * How long a parcel has been at the post office — which is all anybody knows.
 *
 * This file replaced `deadline.test.ts`, and the thing it used to assert is
 * the thing that had to go: a last day computed as arrival plus a per-service
 * "deposit window" an operator typed into Settings. The number started at 15,
 * was flagged "still a guess", and nobody ever confirmed it with Correos —
 * who do not publish it, do not send it, and announce the return themselves
 * when it happens. Every countdown, every "goes back on" date and every date
 * in a customer's message came off it.
 *
 * So: nothing computes a last day, nothing displays one, and no customer is
 * told one. What is left is Correos' own "A disposición del destinatario"
 * time, counted forward in Madrid calendar days.
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
  (await getDb().select().from(shipments).where(eq(shipments.id, id)))[0];

async function arriveAtOffice(code: string, officeCode: string, when: string): Promise<void> {
  await ingestEvent({
    shippingCode: code,
    eventCode: 'H01I350V',
    eventDesc: 'A disposición del destinatario',
    occurredAt: new Date(when),
    source: 'poll',
    officeCode,
    rawPayload: {},
  });
}

describe('nothing computes a last day any more', () => {
  it('leaves office_deadline null even for a parcel sitting at a counter', async () => {
    const f = await makeShipment({ productCode: 'PAQ 48' });
    await arriveAtOffice(f.shippingCode, f.officeCode, '2026-09-01T11:00:00+02:00');

    const ship = await shipmentRow(f.shipmentId);
    expect(ship.state).toBe('at_office');
    // The column survives — dropping it would need a migration run in the
    // right order against a fork somebody has to click Sync on — and nothing
    // writes it and nothing reads it.
    expect(ship.officeDeadline).toBeNull();
    expect(ship.officeArrivedAt).not.toBeNull();
  });

  it('records the arrival to the minute, and counts in whole Madrid days', async () => {
    const f = await makeShipment();
    await arriveAtOffice(f.shippingCode, f.officeCode, '2026-09-01T13:47:00+02:00');

    const ship = await shipmentRow(f.shipmentId);
    expect(madridDateKey(ship.officeArrivedAt!)).toBe('2026-09-01');

    // The day it arrives is day 0, however late in the day the van got there.
    expect(daysAtOffice(ship.officeArrivedAt!, new Date('2026-09-01T23:50:00+02:00'))).toBe(0);
    expect(daysAtOffice(ship.officeArrivedAt!, new Date('2026-09-02T00:10:00+02:00'))).toBe(1);
  });

  it('never goes negative, whatever the clock says', async () => {
    const arrived = new Date('2026-09-10T11:00:00+02:00');
    expect(daysAtOffice(arrived, new Date('2026-09-09T11:00:00+02:00'))).toBe(0);
  });

  it('is null for a parcel that is not at an office', async () => {
    expect(daysAtOffice(null)).toBeNull();
  });
});

describe('the screens show the fact, not a guess', () => {
  it('says "At the office since … · N days" and no last day', async () => {
    const f = await makeShipment();
    await arriveAtOffice(f.shippingCode, f.officeCode, '2026-09-01T11:00:00+02:00');

    clock.set('2026-09-09T10:00:00+02:00');
    const [row] = (await loadRows()).filter((r) => r.id === f.shipmentId);

    expect(row.daysAtOffice).toBe(8);
    expect(row.countdown).toBe('8');
    expect(row.when).toBe('At the office since 01 Sep · 8 days');
    // Nothing anywhere claims to know when it goes back.
    expect(row.when).not.toMatch(/goes back|last day|days left/i);
  });

  it('turns red from eleven days at the office, amber from seven', () => {
    const at = new Date('2026-09-20T10:00:00+02:00');
    const since = (days: number) =>
      new Date(at.getTime() - days * 24 * 3_600_000);

    expect(tone('at_office', since(0), at)).toBe('calm');
    expect(tone('at_office', since(6), at)).toBe('calm');
    expect(tone('at_office', since(7), at)).toBe('warn');
    expect(tone('at_office', since(10), at)).toBe('warn');
    expect(tone('at_office', since(11), at)).toBe('crit');
    expect(tone('at_office', since(20), at)).toBe('crit');
    // Coming back is its own colour, whatever the days say.
    expect(tone('returning', since(1), at)).toBe('ret');
  });

  it('orders the Post office list longest-at-the-office first', async () => {
    const old = await makeShipment({ shippingCode: 'PQ8000000001ES' });
    const fresh = await makeShipment({ shippingCode: 'PQ8000000002ES' });
    await arriveAtOffice(old.shippingCode, old.officeCode, '2026-09-01T11:00:00+02:00');
    await arriveAtOffice(fresh.shippingCode, fresh.officeCode, '2026-09-08T11:00:00+02:00');

    clock.set('2026-09-10T10:00:00+02:00');
    const rows = await officeView();
    expect(rows.map((r) => r.id)).toEqual([old.shipmentId, fresh.shipmentId]);

    // The Parcels screen agrees, and does its ordering in SQL.
    const view = await parcelsView({ status: 'at_office', at: new Date('2026-09-10T10:00:00+02:00') });
    expect(view.rows.map((r) => r.id)).toEqual([old.shipmentId, fresh.shipmentId]);
  });

  it('gives the Parcels row a since-date and a day count, and no Goes back', async () => {
    const f = await makeShipment();
    await arriveAtOffice(f.shippingCode, f.officeCode, '2026-09-01T11:00:00+02:00');

    const at = new Date('2026-09-13T10:00:00+02:00');
    const view = await parcelsView({ status: 'at_office', at });
    const row = view.rows.find((r) => r.id === f.shipmentId)!;

    expect(row.atOffice).toEqual({
      since: '01 Sep',
      sinceExact: expect.any(String),
      days: 12,
      late: true,
    });
    expect('deadline' in row).toBe(false);
    expect('daysLeft' in row).toBe(false);
  });

  it('stops counting once the parcel has left the office', async () => {
    const f = await makeShipment();
    await arriveAtOffice(f.shippingCode, f.officeCode, '2026-09-01T11:00:00+02:00');

    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'E-06', eventDesc: 'Entregado en oficina',
      occurredAt: new Date('2026-09-03T11:00:00+02:00'), source: 'push', rawPayload: {},
    });

    const [row] = (await loadRows()).filter((r) => r.id === f.shipmentId);
    expect(row.state).toBe('collected');
    expect(row.daysAtOffice).toBeNull();
    expect(row.countdown).toBe('–');
  });

  it('leaves the office tabs only when Correos says it is going back', async () => {
    const f = await makeShipment();
    await arriveAtOffice(f.shippingCode, f.officeCode, '2026-09-01T11:00:00+02:00');

    // A fortnight on, with nothing further from Correos, it is still waiting.
    const late = new Date('2026-09-25T10:00:00+02:00');
    expect((await parcelsView({ status: 'at_office', at: late })).rows.map((r) => r.id))
      .toContain(f.shipmentId);

    // Correos' own return event is the only thing that moves it.
    await ingestEvent({
      shippingCode: f.shippingCode, eventCode: 'L03D320R',
      eventDesc: 'Finalizado plazo retirada',
      occurredAt: new Date('2026-09-26T09:00:00+02:00'), source: 'poll', rawPayload: {},
    });

    const after = new Date('2026-09-26T10:00:00+02:00');
    expect((await parcelsView({ status: 'at_office', at: after })).rows.map((r) => r.id))
      .not.toContain(f.shipmentId);
    expect((await parcelsView({ status: 'returning', at: after })).rows.map((r) => r.id))
      .toContain(f.shipmentId);
  });
});

describe('the ordering reads off days at the office', () => {
  const base: DecidableShipment = {
    id: 'x',
    state: 'at_office',
    officeArrivedAt: null,
    officeName: 'Oficina Madrid Sucursal 12',
    town: 'Getafe, Madrid',
    customerName: 'Lucía Fernández Ortiz',
    valueCents: 6490,
    paymentMethod: 'cod',
    dropped: false,
    restocked: false,
    redirectPending: false,
    mutedUntil: null,
    openTasks: [],
    lastContactOutcome: null,
  };

  const at = new Date('2026-09-20T10:00:00+02:00');
  const since = (days: number) => new Date(at.getTime() - days * 24 * 3_600_000);

  it('puts the longest-waiting parcel above a richer, newer one', () => {
    const oldCheap = { ...base, officeArrivedAt: since(13), valueCents: 3000 };
    const freshRich = { ...base, officeArrivedAt: since(1), valueCents: 9000 };
    expect(priority(oldCheap, at)).toBeGreaterThan(priority(freshRich, at));
  });

  it('rises as a parcel sits there', () => {
    const scores = [0, 3, 7, 11, 13].map((d) => priority({ ...base, officeArrivedAt: since(d) }, at));
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });

  it('says why a row is top in days at the office, never days left', () => {
    expect(reason({ ...base, officeArrivedAt: since(12) }, at))
      .toBe('Top of the list: 12 days at the post office · €64.90, cash on delivery.');
    // Below the threshold it says nothing about the days at all, rather than
    // inventing a figure for how long is left.
    expect(reason({ ...base, officeArrivedAt: since(2) }, at))
      .toBe('Top of the list: €64.90, cash on delivery.');
  });
});

describe('Madrid days, not blocks of 86,400 seconds', () => {
  it('counts the night the clocks go back as one day', () => {
    // 25 October 2026, Spain goes from summer to winter time. That day is 25
    // hours long; counting in milliseconds would lose an hour and eventually a
    // whole day off the number on the screen.
    expect(madridDaysBetween(
      new Date('2026-10-24T12:00:00+02:00'),
      new Date('2026-10-25T12:00:00+01:00'),
    )).toBe(1);
  });

  it('counts the night the clocks go forward as one day', () => {
    expect(madridDaysBetween(
      new Date('2027-03-27T12:00:00+01:00'),
      new Date('2027-03-28T12:00:00+02:00'),
    )).toBe(1);
  });

  it('counts days at the office across a clock change without drifting', () => {
    const arrived = new Date('2026-10-20T16:00:00+02:00');
    // 20 October to 4 November is fifteen calendar days, one of them 25 hours.
    expect(daysAtOffice(arrived, new Date('2026-11-04T09:00:00+01:00'))).toBe(15);
  });
});
