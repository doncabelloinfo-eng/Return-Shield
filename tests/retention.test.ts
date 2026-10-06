import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  activity, alerts, closures, contactLog, correosPushInbox, eventReviewQueue,
  importBatches, jobRuns, orders, postcodeStats, productRules, shipmentEvents,
  shipments, stores, tasks, users,
} from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { runCleanup, cutoffFor, countKeptUnfinished, databaseBytes } from '@/lib/cleanup';
import { retentionDays, MIN_RETENTION_DAYS, DEFAULT_RETENTION_DAYS } from '@/lib/retention';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The rolling thirty-day window.
 *
 * These are the tests where a bug costs real data, so they are written the
 * other way round from most: the assertions that matter are about what SURVIVES.
 * A cleanup that deletes too little shows up as a full database in a month; a
 * cleanup that deletes too much is gone.
 */

const NOW = '2026-10-07T03:15:00+02:00';
let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
  delete process.env.RETENTION_DAYS;
});

afterEach(() => { delete process.env.RETENTION_DAYS; });

afterAll(async () => {
  resetClock();
  await closeDb();
});

/** Madrid-midnight-aligned: `days` whole days before the test clock's day. */
function daysBack(days: number): Date {
  return new Date(cutoffFor(clock.now(), days).getTime() + 10 * 3_600_000);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const countOf = async (table: any): Promise<number> =>
  (await getDb().select().from(table)).length;

/* ========================================================================== */

describe('the window', () => {
  it('is 30 days by default', () => {
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
  });

  it('can be raised', () => {
    process.env.RETENTION_DAYS = '90';
    expect(retentionDays()).toBe(90);
  });

  it.each(['13', '1', '0', '-5'])('clamps %s to the floor', (value) => {
    // The escalation ladder runs over a fifteen-day deposit window, so a
    // shorter retention would delete parcels that are still being chased and
    // the chasing would stop with no trace of why. An environment variable
    // must not be able to do that.
    process.env.RETENTION_DAYS = value;
    expect(retentionDays()).toBe(MIN_RETENTION_DAYS);
  });

  it.each(['', '   ', 'abc', 'thirty'])('falls back to 30 when the value is %j', (value) => {
    // Not a number is a different mistake from asking for too few days, and
    // it gets the safe default rather than the floor: a typo should not delete
    // sixteen days more than it was going to.
    process.env.RETENTION_DAYS = value;
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('says so in the job detail when it clamped', async () => {
    process.env.RETENTION_DAYS = '3';
    const report = await runCleanup(clock.now());

    expect(report.windowDays).toBe(MIN_RETENTION_DAYS);
    expect(report.note).toContain('less than 14');
  });

  it('cuts on a Madrid day boundary, not on a rolling 30×86,400,000', async () => {
    // Subtracting milliseconds makes the edge of the window drift through the
    // night, so a run at 03:15 and a run at 03:20 disagree about a parcel on
    // the boundary — and on the night the clocks change, by an hour.
    const early = cutoffFor(new Date('2026-10-07T00:05:00+02:00'));
    const late = cutoffFor(new Date('2026-10-07T23:55:00+02:00'));
    expect(early.toISOString()).toBe(late.toISOString());
  });
});

/* ========================================================================== */

describe('finished orders', () => {
  it('deletes one from 31 days back, with everything hanging off it', async () => {
    const fix = await makeShipment({
      shippingCode: 'POLD', state: 'delivered', orderCreatedAt: daysBack(31),
    });
    await getDb().insert(shipmentEvents).values({
      shipmentId: fix.shipmentId, rawPayload: {}, eventCode: 'E1',
      eventDesc: 'Entregado', occurredAt: daysBack(31), receivedAt: daysBack(31),
      source: 'poll', mappedState: 'delivered',
    });
    await getDb().insert(contactLog).values({
      shipmentId: fix.shipmentId, at: daysBack(31), outcome: 'Will pick it up', note: '',
    });
    await getDb().insert(tasks).values({
      shipmentId: fix.shipmentId, type: 'call', reason: 'test', label: 'Ring them',
      status: 'done', createdAt: daysBack(31),
    });

    const report = await runCleanup(clock.now());

    expect(report.orders).toBe(1);
    // ON DELETE CASCADE does the rest. Asserted rather than assumed: the
    // cleanup relies on it entirely and would otherwise fail on a foreign key.
    expect(await countOf(orders)).toBe(0);
    expect(await countOf(shipments)).toBe(0);
    expect(await countOf(shipmentEvents)).toBe(0);
    expect(await countOf(contactLog)).toBe(0);
    expect(await countOf(tasks)).toBe(0);
  });

  it('keeps one from 30 days back, and takes it the next night', async () => {
    await makeShipment({
      shippingCode: 'PEDGE', state: 'delivered', orderCreatedAt: daysBack(30),
    });

    // Day 30 is the oldest day still inside the window.
    expect((await runCleanup(clock.now())).orders).toBe(0);
    expect(await countOf(orders)).toBe(1);

    // One day later it is the thirty-first day back, and it goes.
    clock.set('2026-10-08T03:15:00+02:00');
    expect((await runCleanup(clock.now())).orders).toBe(1);
    expect(await countOf(orders)).toBe(0);
  });

  it('counts a parcel closed by hand as finished', async () => {
    const fix = await makeShipment({
      shippingCode: 'PCL', state: 'in_transit', orderCreatedAt: daysBack(31),
    });
    await getDb().update(shipments)
      .set({ droppedAt: daysBack(31), closeReason: 'lost' })
      .where(eq(shipments.id, fix.shipmentId));

    expect((await runCleanup(clock.now())).orders).toBe(1);
  });

  it('keeps an order whose other parcel is still going', async () => {
    // One order, two parcels. Deleting the order would take the live one with
    // it and stop its tracking, because the reconcile sweep reads `shipments`.
    const fix = await makeShipment({
      shippingCode: 'PA', state: 'delivered', orderCreatedAt: daysBack(40),
    });
    await getDb().insert(shipments).values({
      orderId: fix.orderId, shippingCode: 'PB', productCode: 'PAQ ESTÁNDAR', state: 'in_transit',
    });

    expect((await runCleanup(clock.now())).orders).toBe(0);
    expect(await countOf(orders)).toBe(1);
  });
});

describe('unfinished parcels past the window', () => {
  it('are kept, however old', async () => {
    await makeShipment({
      shippingCode: 'PLIVE', state: 'at_office', orderCreatedAt: daysBack(90),
    });

    const report = await runCleanup(clock.now());

    // Ninety days old and still being chased. This is exactly the parcel that
    // needs a human, and deleting it would also stop its tracking.
    expect(report.orders).toBe(0);
    expect(report.keptUnfinished).toBe(1);
    expect(await countOf(orders)).toBe(1);
  });

  it('go the night after they finish', async () => {
    const fix = await makeShipment({
      shippingCode: 'PFIN', state: 'at_office', orderCreatedAt: daysBack(90),
    });

    expect((await runCleanup(clock.now())).orders).toBe(0);

    await getDb().update(shipments).set({ state: 'collected' })
      .where(eq(shipments.id, fix.shipmentId));

    const report = await runCleanup(clock.now());
    expect(report.orders).toBe(1);
    expect(report.keptUnfinished).toBe(0);
  });

  it('are counted for the digest', async () => {
    await makeShipment({ shippingCode: 'PK1', state: 'in_transit', orderCreatedAt: daysBack(45) });
    await makeShipment({ shippingCode: 'PK2', state: 'failed', orderCreatedAt: daysBack(60) });
    await makeShipment({ shippingCode: 'PK3', state: 'delivered', orderCreatedAt: daysBack(45) });
    await makeShipment({ shippingCode: 'PK4', state: 'in_transit', orderCreatedAt: daysBack(5) });

    // Only the two that are both past the window and still going.
    expect(await countKeptUnfinished(cutoffFor(clock.now()))).toBe(2);
  });
});

/* ========================================================================== */

describe('the other tables', () => {
  it('cuts activity at the window', async () => {
    await getDb().insert(activity).values([
      { at: daysBack(31), text: 'old' },
      { at: daysBack(29), text: 'recent' },
    ]);

    const report = await runCleanup(clock.now());

    expect(report.activity).toBe(1);
    expect((await getDb().select().from(activity)).map((a) => a.text)).toEqual(['recent']);
  });

  it('cuts job runs at the window', async () => {
    await getDb().insert(jobRuns).values([
      { job: 'escalation-tick', startedAt: daysBack(31), ok: true },
      { job: 'escalation-tick', startedAt: daysBack(2), ok: true },
    ]);

    expect((await runCleanup(clock.now())).jobRuns).toBe(1);
    expect(await countOf(jobRuns)).toBe(1);
  });

  it('cuts import batches at the window', async () => {
    const [store] = await getDb().insert(stores).values({
      key: 'ret-import', name: 'Ret Import', platform: 'tiktok', ingest: 'manual',
    }).returning({ id: stores.id });

    await getDb().insert(importBatches).values([
      { storeId: store.id, filename: 'old.csv', createdAt: daysBack(31) },
      { storeId: store.id, filename: 'new.csv', createdAt: daysBack(1) },
    ]);

    expect((await runCleanup(clock.now())).importBatches).toBe(1);
    expect((await getDb().select().from(importBatches)).map((b) => b.filename)).toEqual(['new.csv']);
  });

  it('cuts processed push payloads at the window, not at 90 days', async () => {
    await getDb().insert(correosPushInbox).values([
      { payload: {}, receivedAt: daysBack(40), processedAt: daysBack(40) },
      { payload: {}, receivedAt: daysBack(10), processedAt: daysBack(10) },
    ]);

    expect((await runCleanup(clock.now())).pushInbox).toBe(1);
  });

  it('keeps an unprocessed push payload however old', async () => {
    // Unprocessed means the normaliser never read it. That is the one body
    // worth keeping: fix the normaliser and replay.
    await getDb().insert(correosPushInbox).values({ payload: {}, receivedAt: daysBack(200) });

    expect((await runCleanup(clock.now())).pushInbox).toBe(0);
    expect(await countOf(correosPushInbox)).toBe(1);
  });

  it('cuts delivered alerts and keeps undelivered ones', async () => {
    await getDb().insert(alerts).values([
      { dedupeKey: 'a', subject: 'sent', body: '', createdAt: daysBack(40), sentAt: daysBack(40) },
      // Never delivered. Unfinished business, whatever its age.
      { dedupeKey: 'b', subject: 'never sent', body: '', createdAt: daysBack(40) },
    ]);

    expect((await runCleanup(clock.now())).alerts).toBe(1);
    expect((await getDb().select().from(alerts)).map((a) => a.subject)).toEqual(['never sent']);
  });

  it('cuts resolved review rows and keeps unresolved ones', async () => {
    await getDb().insert(eventReviewQueue).values([
      {
        eventCode: 'R1', eventDesc: 'resolved', samplePayload: {},
        firstSeenAt: daysBack(40), lastSeenAt: daysBack(40), resolvedAt: daysBack(40),
      },
      // Still a to-do list rather than a log: nobody has mapped this wording.
      { eventCode: 'R2', eventDesc: 'open', samplePayload: {}, firstSeenAt: daysBack(40), lastSeenAt: daysBack(40) },
    ]);

    expect((await runCleanup(clock.now())).reviewQueue).toBe(1);
    expect((await getDb().select().from(eventReviewQueue)).map((r) => r.eventCode)).toEqual(['R2']);
  });

  it('drops postcodes with no orders left behind them', async () => {
    await makeShipment({ shippingCode: 'PPC', state: 'in_transit', postalCode: '28901' });
    await getDb().insert(postcodeStats).values([
      { postalCode: '28901', town: 'Getafe', shipped: 10, failed: 3, failRate: 0.3, watch: true },
      // The last parcel for this one aged out of the window. Keeping it would
      // leave a flagged area on the Settings screen with nothing behind it.
      { postalCode: '08001', town: 'Barcelona', shipped: 9, failed: 4, failRate: 0.44, watch: true },
    ]);

    expect((await runCleanup(clock.now())).postcodes).toBe(1);
    expect((await getDb().select().from(postcodeStats)).map((p) => p.postalCode)).toEqual(['28901']);
  });
});

/* ========================================================================== */

describe('what is never deleted', () => {
  it('leaves configuration and the closure record alone', async () => {
    const fix = await makeShipment({
      shippingCode: 'PKEEP', state: 'delivered', orderCreatedAt: daysBack(40),
    });
    const [user] = await getDb().insert(users).values({
      email: 'keep@example.com', name: 'Keep', passwordHash: 'x',
    }).returning();
    await getDb().insert(closures).values({
      shipmentId: fix.shipmentId,
      orderNumber: 'OLD-1', storeName: 'Shop', shippingCode: 'PKEEP',
      reason: 'lost', valueCents: 4900, daysSinceOrder: 40,
      closedAt: daysBack(40), closedBy: user.id,
    });

    await runCleanup(clock.now());

    // The order and the parcel are gone; the record of the write-off is not.
    expect(await countOf(orders)).toBe(0);
    expect(await countOf(closures)).toBe(1);
    expect(await countOf(users)).toBe(1);
    expect(await countOf(stores)).toBe(1);
    expect(await countOf(productRules)).toBe(1);

    // And its link to the parcel went null rather than taking the row with it.
    const [row] = await getDb().select().from(closures);
    expect(row.shipmentId).toBeNull();
    expect(row.orderNumber).toBe('OLD-1');
  });
});

describe('the report', () => {
  it('says what it did and what the database weighs', async () => {
    await makeShipment({ shippingCode: 'PR1', state: 'delivered', orderCreatedAt: daysBack(31) });

    const report = await runCleanup(clock.now());

    expect(report.windowDays).toBe(30);
    expect(report.keepFrom).toMatch(/^2026-09-/);
    expect(report.orders).toBe(1);
    expect(report.note).toBeUndefined();
    expect(await databaseBytes()).toBeGreaterThan(0);
  });

  it('is safe to run twice, and does nothing the second time', async () => {
    await makeShipment({ shippingCode: 'PR2', state: 'delivered', orderCreatedAt: daysBack(31) });

    expect((await runCleanup(clock.now())).orders).toBe(1);
    expect((await runCleanup(clock.now())).orders).toBe(0);
  });

  it('does nothing at all on an empty database', async () => {
    const report = await runCleanup(clock.now());
    expect(report.orders).toBe(0);
    expect(report.activity).toBe(0);
  });
});
