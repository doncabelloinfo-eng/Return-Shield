import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipmentEvents, shipments } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { parcelsView, parseDayFilter } from '@/lib/views/parcels';
import { reproject } from '@/lib/shipments/repo';
import { runCleanup, cutoffFor, countKeptUnfinished } from '@/lib/cleanup';
import { parseDate } from '@/lib/import/parse';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The ship date, and everything that counts from it.
 *
 * It exists because `orders.created_at` is not the day a parcel went out, and
 * after a thirty-day pull it is not even close: every pulled order is written
 * with today's date. A retention window counted from that would keep a parcel
 * posted five weeks ago for another thirty days, and the first pull would hold
 * two months at once.
 */

const WED = '2026-10-07T10:00:00+02:00';
let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(WED);
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

const count = (tabs: { id: string; count: number }[], id: string) =>
  tabs.find((t) => t.id === id)?.count ?? 0;

/* ========================================================================== */

describe('the fallback chain', () => {
  it('uses the source date when there is one', async () => {
    const fix = await makeShipment({ shippingCode: 'PS1' });
    await getDb().update(shipments).set({ shippedAt: new Date('2026-10-02T08:00:00Z') })
      .where(eq(shipments.id, fix.shipmentId));

    const v = await parcelsView({ status: 'created', at: clock.now() });
    expect(v.rows[0].shippedOn).toBe('02 Oct');
  });

  it('falls back to the Prerregistrado event', async () => {
    const fix = await makeShipment({ shippingCode: 'PS2' });
    await getDb().insert(shipmentEvents).values({
      shipmentId: fix.shipmentId,
      rawPayload: {},
      eventCode: 'A090000V',
      eventDesc: 'Prerregistrado',
      occurredAt: new Date('2026-10-03T07:30:00Z'),
      receivedAt: clock.now(),
      source: 'poll',
      mappedState: 'created',
    });

    await reproject(fix.shipmentId);

    const [row] = await getDb().select().from(shipments).where(eq(shipments.id, fix.shipmentId));
    expect(row.shippedAt?.toISOString()).toBe('2026-10-03T07:30:00.000Z');
  });

  it('takes the FIRST Prerregistrado, not the newest', async () => {
    const fix = await makeShipment({ shippingCode: 'PS3' });
    for (const at of ['2026-10-01T07:00:00Z', '2026-10-04T07:00:00Z']) {
      await getDb().insert(shipmentEvents).values({
        shipmentId: fix.shipmentId,
        rawPayload: {},
        eventCode: 'A090000V',
        eventDesc: 'Prerregistrado',
        occurredAt: new Date(at),
        receivedAt: clock.now(),
        source: 'poll',
        mappedState: 'created',
      });
    }

    await reproject(fix.shipmentId);

    const [row] = await getDb().select().from(shipments).where(eq(shipments.id, fix.shipmentId));
    // A label re-registered after a problem must not move the parcel forward
    // in the retention window.
    expect(row.shippedAt?.toISOString()).toBe('2026-10-01T07:00:00.000Z');
  });

  it('does not let the event overwrite a real source date', async () => {
    const fix = await makeShipment({ shippingCode: 'PS4' });
    await getDb().update(shipments).set({ shippedAt: new Date('2026-10-02T08:00:00Z') })
      .where(eq(shipments.id, fix.shipmentId));
    await getDb().insert(shipmentEvents).values({
      shipmentId: fix.shipmentId,
      rawPayload: {},
      eventCode: 'A090000V',
      eventDesc: 'Prerregistrado',
      occurredAt: new Date('2026-10-04T07:00:00Z'),
      receivedAt: clock.now(),
      source: 'poll',
      mappedState: 'created',
    });

    await reproject(fix.shipmentId);

    const [row] = await getDb().select().from(shipments).where(eq(shipments.id, fix.shipmentId));
    // The fulfilment date is the real thing; Correos' first sighting of the
    // label is hours to days later.
    expect(row.shippedAt?.toISOString()).toBe('2026-10-02T08:00:00.000Z');
  });

  it('falls back to when we first saw the row', async () => {
    await makeShipment({
      shippingCode: 'PS5',
      orderCreatedAt: new Date('2026-10-01T09:00:00Z'),
    });

    const v = await parcelsView({ status: 'created', at: clock.now() });
    expect(v.rows[0].shippedOn).toBe('01 Oct');
  });
});

describe('a date with no time', () => {
  it('is that Madrid day', () => {
    // "2026-10-06" from a marketplace file. Madrid is UTC+2 in October, so
    // midnight local is 22:00 the day before in UTC — and the day it belongs
    // to is the 6th either way.
    const parsed = parseDate('2026-10-06');
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString().slice(0, 10)).toBe('2026-10-06');
  });
});

/* ========================================================================== */

describe('the order date column', () => {
  it('shows a Shopify order date', async () => {
    await makeShipment({ shippingCode: 'PO1' });
    const v = await parcelsView({ status: 'created', at: clock.now() });
    expect(v.rows[0].orderedOn).toBe('01 Sep');
  });

  it('is null for a marketplace row, so the screen shows a dash', async () => {
    const fix = await makeShipment({ shippingCode: 'PO2' });
    await getDb().execute(
      (await import('drizzle-orm')).sql`UPDATE orders SET placed_at = NULL`,
    );

    const v = await parcelsView({ status: 'created', at: clock.now() });
    expect(v.rows[0].orderedOn).toBeNull();
    expect(fix.shipmentId).toBeTruthy();
  });
});

describe('the date filter', () => {
  beforeEach(async () => {
    const days: [string, string][] = [
      ['PD1', '2026-10-05T09:00:00Z'],
      ['PD2', '2026-10-06T09:00:00Z'],
      ['PD3', '2026-10-06T21:30:00Z'],
      ['PD4', '2026-10-07T09:00:00Z'],
    ];
    for (const [code, shippedAt] of days) {
      const fix = await makeShipment({ shippingCode: code, state: 'in_transit' });
      await getDb().update(shipments).set({ shippedAt: new Date(shippedAt) })
        .where(eq(shipments.id, fix.shipmentId));
    }
  });

  it('lists exactly that Madrid day', async () => {
    const v = await parcelsView({ status: 'in_transit', date: '2026-10-06', at: clock.now() });

    // 21:30 UTC on the 6th is 23:30 in Madrid — still the 6th.
    expect(v.rows.map((r) => r.shippingCode).sort()).toEqual(['PD2', 'PD3']);
  });

  it('makes the tab counts follow it', async () => {
    const v = await parcelsView({ status: 'in_transit', date: '2026-10-05', at: clock.now() });

    expect(count(v.tabs, 'in_transit')).toBe(1);
    expect(v.total).toBe(1);
  });

  it('combines with the search', async () => {
    const fix = await makeShipment({
      shippingCode: 'PD5', state: 'in_transit', customerName: 'Ana Ruiz',
    });
    await getDb().update(shipments).set({ shippedAt: new Date('2026-10-06T10:00:00Z') })
      .where(eq(shipments.id, fix.shipmentId));

    const v = await parcelsView({
      status: 'in_transit', date: '2026-10-06', q: 'Ana', at: clock.now(),
    });

    expect(v.rows.map((r) => r.shippingCode)).toEqual(['PD5']);
  });

  it('combines with the shop filter', async () => {
    const fix = await makeShipment({
      shippingCode: 'PD6', state: 'in_transit', storeKey: 'other', storeName: 'Otra Tienda',
    });
    await getDb().update(shipments).set({ shippedAt: new Date('2026-10-06T10:00:00Z') })
      .where(eq(shipments.id, fix.shipmentId));

    const v = await parcelsView({
      status: 'in_transit', date: '2026-10-06', store: 'Otra Tienda', at: clock.now(),
    });

    expect(v.rows.map((r) => r.shippingCode)).toEqual(['PD6']);
  });

  it('stays inside the selected tab', async () => {
    const fix = await makeShipment({ shippingCode: 'PD7', state: 'delivered' });
    await getDb().update(shipments).set({ shippedAt: new Date('2026-10-06T10:00:00Z') })
      .where(eq(shipments.id, fix.shipmentId));

    const v = await parcelsView({ status: 'in_transit', date: '2026-10-06', at: clock.now() });
    expect(v.rows.map((r) => r.shippingCode).sort()).toEqual(['PD2', 'PD3']);
  });

  it('ignores a value that is not a date', async () => {
    // A hand-edited URL should narrow nothing rather than show nothing.
    for (const bad of ['banana', '2026-13-01', '2026-10', '']) {
      const v = await parcelsView({ status: 'in_transit', date: bad, at: clock.now() });
      expect(v.rows).toHaveLength(4);
    }
  });

  it('parses a day into a half-open Madrid range', () => {
    const day = parseDayFilter('2026-10-06');
    expect(day).not.toBeNull();
    // Half-open, so 23:59:59.4 on the 6th belongs to the 6th.
    expect(day!.from.toISOString()).toBe('2026-10-05T22:00:00.000Z');
    expect(day!.until.toISOString()).toBe('2026-10-06T22:00:00.000Z');
  });
});

/* ========================================================================== */

describe('the retention window, by ship date', () => {
  it('deletes a finished order shipped 31 days ago, whatever day its row was written', async () => {
    const fix = await makeShipment({
      shippingCode: 'PW1',
      state: 'delivered',
      // Written yesterday, which is what a thirty-day pull does to every row
      // it creates.
      orderCreatedAt: new Date('2026-10-06T10:00:00Z'),
    });
    await getDb().update(shipments)
      .set({ shippedAt: new Date(cutoffFor(clock.now(), 31).getTime() + 3_600_000) })
      .where(eq(shipments.id, fix.shipmentId));

    const report = await runCleanup(clock.now());
    expect(report.orders).toBe(1);
  });

  it('keeps one shipped 30 days ago', async () => {
    const fix = await makeShipment({ shippingCode: 'PW2', state: 'delivered' });
    await getDb().update(shipments)
      .set({ shippedAt: new Date(cutoffFor(clock.now(), 30).getTime() + 3_600_000) })
      .where(eq(shipments.id, fix.shipmentId));

    expect((await runCleanup(clock.now())).orders).toBe(0);
  });

  it('keeps one whose row is old but whose parcel went out yesterday', async () => {
    // The opposite mistake: an order record created a month ago whose parcel
    // only shipped yesterday. Counting from the row would delete a live parcel.
    const fix = await makeShipment({
      shippingCode: 'PW3',
      state: 'delivered',
      orderCreatedAt: new Date(cutoffFor(clock.now(), 40).getTime()),
    });
    await getDb().update(shipments).set({ shippedAt: new Date('2026-10-06T10:00:00Z') })
      .where(eq(shipments.id, fix.shipmentId));

    expect((await runCleanup(clock.now())).orders).toBe(0);
  });

  it('counts the kept-unfinished by ship date too', async () => {
    const fix = await makeShipment({
      shippingCode: 'PW4', state: 'in_transit',
      orderCreatedAt: new Date('2026-10-06T10:00:00Z'),
    });
    await getDb().update(shipments)
      .set({ shippedAt: new Date(cutoffFor(clock.now(), 45).getTime()) })
      .where(eq(shipments.id, fix.shipmentId));

    expect(await countKeptUnfinished(cutoffFor(clock.now()))).toBe(1);
  });

  it('is what the Stuck 30+ days tab uses', async () => {
    const fix = await makeShipment({
      shippingCode: 'PW5', state: 'in_transit',
      orderCreatedAt: new Date('2026-10-06T10:00:00Z'),
    });
    await getDb().update(shipments)
      .set({ shippedAt: new Date(cutoffFor(clock.now(), 31).getTime()) })
      .where(eq(shipments.id, fix.shipmentId));

    const v = await parcelsView({ status: 'stuck_30', at: clock.now() });

    // The tab and the cleanup now agree. The tab used to subtract
    // 30 × 86,400,000 ms from `orders.created_at`, which drifts through the
    // day and ignored the ship date entirely.
    expect(v.rows).toHaveLength(1);
    expect(count(v.tabs, 'stuck_30')).toBe(1);
  });
});
