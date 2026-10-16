import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { runCleanup } from '@/lib/cleanup';
import { SCAN_RETENTION_DAYS } from '@/lib/scan/model';
import { openBatch } from '@/lib/scan/batches';
import { TestClock, resetClock, DAY } from '@/lib/clock';
import { resetDb, closeDb } from './helpers/db';
import { makeScan, makeShipment, makeUser } from './helpers/fixtures';

/**
 * Scans are kept ninety days, on a clock of their own.
 *
 * SEPARATE FROM THE PARCELS' THIRTY, and that separation is the feature rather
 * than an accident of configuration. A scan has no foreign key to `shipments`,
 * so the rolling thirty-day window cannot take one with it — which is what lets
 * a return scanned on day 40 still say the parcel left the warehouse on day 2,
 * and what keeps a matched return under "From Return Shield" after its parcel
 * has gone.
 *
 * The two windows are tested against each other here, in both directions,
 * because "they do not interfere" is the kind of claim that is true until
 * somebody adds a foreign key for tidiness.
 */

let clock: InstanceType<typeof TestClock>;
let worker = '';

const NOW = '2026-10-16T03:30:00+02:00';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
  worker = (await makeUser({ role: 'scanner', name: 'María' })).id;
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

/** Days back from the nightly run, at midday so no boundary is straddled. */
function daysAgo(days: number): Date {
  return new Date(clock.now().getTime() - days * DAY);
}

async function count(table: 'scans' | 'scan_batches' | 'shipments'): Promise<number> {
  const result = await getDb().execute(raw`SELECT count(*)::int AS n FROM ${raw.identifier(table)}`);
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
}

describe('the ninety-day window', () => {
  it('is ninety days', () => {
    expect(SCAN_RETENTION_DAYS).toBe(90);
  });

  it('keeps a scan from day 89 and removes one from day 91', async () => {
    await makeScan({ code: 'PKA6TP980010089E', userId: worker, at: daysAgo(89) });
    await makeScan({ code: 'PKA6TP980010091E', userId: worker, at: daysAgo(91) });
    expect(await count('scans')).toBe(2);

    const report = await runCleanup(clock.now());

    expect(report.scans).toBe(1);
    expect(report.scanWindowDays).toBe(90);

    const left = await getDb().execute(raw`SELECT base FROM scans`);
    expect(rowsOf<{ base: string }>(left).map((r) => r.base)).toEqual(['PKA6TP980010089']);
  });

  it('removes a batch only once every scan in it has gone', async () => {
    const batch = await openBatch(worker, 'outgoing');

    // One old scan and one inside the window, in the same batch.
    await makeScan({ code: 'PKA6TP980010091E', userId: worker, at: daysAgo(91), batchId: batch.id });
    await makeScan({ code: 'PKA6TP980010010E', userId: worker, at: daysAgo(10), batchId: batch.id });

    await runCleanup(clock.now());

    // The batch survives, because deleting it would cascade and take the scan
    // that is still inside its window with it.
    expect(await count('scan_batches')).toBe(1);
    expect(await count('scans')).toBe(1);
  });

  it('removes an old batch once it is empty', async () => {
    const old = await openBatch(worker, 'outgoing');
    await getDb().execute(raw`
      UPDATE scan_batches SET started_at = ${daysAgo(120).toISOString()}::timestamptz
       WHERE id = ${old.id}
    `);
    await makeScan({ code: 'PKA6TP980010091E', userId: worker, at: daysAgo(120), batchId: old.id });

    const report = await runCleanup(clock.now());

    expect(report.scans).toBe(1);
    expect(report.scanBatches).toBe(1);
    expect(await count('scan_batches')).toBe(0);
  });
});

describe('the two windows, against each other', () => {
  it('does not take a scan when the parcel it matched is cleaned up', async () => {
    // The parcel is 40 days old and finished, so the thirty-day window takes
    // it. The scan is 10 days old and must stay — it is the record that the
    // return came back.
    await makeShipment({
      shippingCode: 'PKA6TP980010040E',
      state: 'delivered',
      orderCreatedAt: daysAgo(40),
    });
    await makeScan({
      code: 'PKA6TP980010040E',
      userId: worker,
      direction: 'incoming',
      at: daysAgo(10),
      orderNumber: '#22709',
      storeName: 'Don Cabello Profesional',
    });

    const report = await runCleanup(clock.now());

    expect(report.orders).toBe(1);
    expect(await count('shipments')).toBe(0);
    expect(report.scans).toBe(0);
    expect(await count('scans')).toBe(1);
  });

  it('does not keep a parcel alive because a scan points at it', async () => {
    // And the other way round: a scan is not a reference, so it cannot hold a
    // finished parcel past its own window.
    await makeShipment({
      shippingCode: 'PKA6TP980010041E',
      state: 'delivered',
      orderCreatedAt: daysAgo(40),
    });
    await makeScan({ code: 'PKA6TP980010041E', userId: worker, at: daysAgo(1) });

    await runCleanup(clock.now());
    expect(await count('shipments')).toBe(0);
  });

  it('leaves a parcel inside the thirty days alone when its scan ages out', async () => {
    await makeShipment({ shippingCode: 'PKA6TP980010042E', orderCreatedAt: daysAgo(3) });
    await makeScan({ code: 'PKA6TP980010042E', userId: worker, at: daysAgo(100) });

    const report = await runCleanup(clock.now());

    expect(report.scans).toBe(1);
    expect(report.orders).toBe(0);
    expect(await count('shipments')).toBe(1);
  });
});
