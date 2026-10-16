import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import {
  addScan, currentBatch, finishBatch, openBatch, previewBatch, removeScan,
  stampFor, CLOCK_SLACK_MS,
} from '@/lib/scan/batches';
import { summarise } from '@/lib/scan/items';
import { TestClock, resetClock, HOUR } from '@/lib/clock';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment, makeUser } from './helpers/fixtures';

/**
 * A batch: one pile of parcels, worked through by one person.
 *
 * The three things that must hold whatever the warehouse wifi does:
 *
 *   · the same parcel read twice is ONE row, marked "scanned twice";
 *   · the same READ sent twice — which is what a retry is — changes nothing;
 *   · the counts on the finish screen are the rows, not a separate count.
 *
 * The second is the one that is easy to get wrong and impossible to notice: a
 * retry that counted again would turn an ordinary scan into "scanned twice",
 * and the operator would be reading numbers that quietly drift up with the
 * signal strength.
 */

const CODE_A = 'PKA6TP9800101520108320G';
const CODE_B = 'PKA6TP9800101530130565B';

let clock: InstanceType<typeof TestClock>;
let worker = '';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-16T10:00:00+02:00');
  clock.install();
  worker = (await makeUser({ role: 'scanner', name: 'María' })).id;
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

async function scanCount(): Promise<number> {
  const result = await getDb().execute(raw`SELECT count(*)::int AS n FROM scans`);
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
}

describe('opening a batch', () => {
  it('gives the same open batch back, however many times it is asked', async () => {
    // The phone asks on every start, and two asks racing must not split a pile.
    const first = await openBatch(worker, 'outgoing');
    const second = await openBatch(worker, 'outgoing');

    expect(second.id).toBe(first.id);
  });

  it('keeps outgoing and incoming apart', async () => {
    const out = await openBatch(worker, 'outgoing');
    const back = await openBatch(worker, 'incoming');

    expect(back.id).not.toBe(out.id);
  });

  it('opens a new one once the old is finished', async () => {
    const first = await openBatch(worker, 'outgoing');
    await finishBatch(worker, first.id);

    const second = await openBatch(worker, 'outgoing');
    expect(second.id).not.toBe(first.id);
  });

  it('resumes the open batch, with everything in it', async () => {
    // A phone that ran out of battery mid-pile, or a different phone.
    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });

    const resumed = await currentBatch(worker, 'outgoing');
    expect(resumed?.id).toBe(batch.id);
    expect(resumed?.items.map((i) => i.codeAsRead)).toEqual([CODE_A]);
  });
});

describe('a duplicate in a batch', () => {
  it('is kept once, and counted as scanned twice', async () => {
    const batch = await openBatch(worker, 'outgoing');

    const first = await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    const again = await addScan(worker, { batchId: batch.id, readId: 'r2', code: CODE_A, source: 'barcode' });

    expect(first).toMatchObject({ ok: true, duplicate: false, counted: true });
    expect(again).toMatchObject({ ok: true, duplicate: true, counted: true });
    if (!again.ok) return;

    expect(again.item.timesRead).toBe(2);
    expect(await scanCount()).toBe(1);

    const open = await currentBatch(worker, 'outgoing');
    expect(open?.items).toHaveLength(1);
    expect(summarise(open?.items ?? []).scannedTwice).toBe(1);
  });

  it('counts the same code read lowercase, with a space, as the same parcel', async () => {
    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    const typed = await addScan(worker, {
      batchId: batch.id, readId: 'r2', code: ' pka6tp9800101520108320 g ', source: 'typed',
    });

    expect(typed).toMatchObject({ ok: true, duplicate: true });
    expect(await scanCount()).toBe(1);
  });

  it('keeps two boxes of one shipment apart', async () => {
    /*
     * A multi-parcel shipment prints one EXPEDICIÓN and a Código de Bulto per
     * box, so parcel 01 and parcel 02 share their first fifteen characters and
     * are two parcels. Collapsing them would lose a box that really did leave
     * the warehouse, which is worse than the opposite mistake.
     */
    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: 'PKA6TP9800101520108320G', source: 'barcode' });
    const second = await addScan(worker, { batchId: batch.id, readId: 'r2', code: 'PKA6TP9800101520208320H', source: 'barcode' });

    expect(second).toMatchObject({ ok: true, duplicate: false });
    expect(await scanCount()).toBe(2);
  });
});

describe('a retry', () => {
  it('stores the scan once, however many times it is sent', async () => {
    const batch = await openBatch(worker, 'outgoing');

    const first = await addScan(worker, { batchId: batch.id, readId: 'same-read', code: CODE_A, source: 'barcode' });
    const retry = await addScan(worker, { batchId: batch.id, readId: 'same-read', code: CODE_A, source: 'barcode' });
    const again = await addScan(worker, { batchId: batch.id, readId: 'same-read', code: CODE_A, source: 'barcode' });

    expect(first).toMatchObject({ ok: true, counted: true });
    // `counted: false` is the server saying "I already had this read".
    expect(retry).toMatchObject({ ok: true, counted: false });
    expect(again).toMatchObject({ ok: true, counted: false });

    expect(await scanCount()).toBe(1);
    if (!again.ok) return;
    expect(again.item.timesRead).toBe(1);
  });

  it('does not turn an ordinary scan into "scanned twice"', async () => {
    // The whole point. Without `read_ids`, this would read 3.
    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });

    const open = await currentBatch(worker, 'outgoing');
    expect(open?.items[0].timesRead).toBe(1);
    expect(summarise(open?.items ?? []).scannedTwice).toBe(0);
  });
});

describe('the same code in two batches', () => {
  it('is two rows, one in each', async () => {
    // A parcel scanned out this morning and scanned out again after it came
    // back inside is two facts, both true.
    const first = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: first.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    await finishBatch(worker, first.id);

    clock.advanceHours(2);
    const second = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: second.id, readId: 'r2', code: CODE_A, source: 'barcode' });

    expect(await scanCount()).toBe(2);
    expect((await currentBatch(worker, 'outgoing'))?.items).toHaveLength(1);
  });
});

describe('finishing a batch', () => {
  it('counts exactly the rows it closed', async () => {
    await makeShipment({ shippingCode: CODE_A, orderNumber: '#22709', storeName: 'Don Cabello Profesional' });

    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    await addScan(worker, { batchId: batch.id, readId: 'r2', code: CODE_B, source: 'typed' });
    await addScan(worker, { batchId: batch.id, readId: 'r3', code: CODE_B, source: 'barcode' });

    const done = await finishBatch(worker, batch.id);
    expect(done).not.toBeNull();
    if (!done) return;

    expect(done.summary.scanned).toBe(done.batch.items.length);
    expect(done.summary.scanned).toBe(2);
    expect(done.summary.found).toBe(1);
    expect(done.summary.notFound).toBe(1);
    expect(done.summary.typed).toBe(1);
    expect(done.summary.scannedTwice).toBe(1);
    expect(done.summary.found + done.summary.notFound).toBe(done.summary.scanned);
    expect(done.batch.finishedAt).not.toBeNull();
  });

  it('is idempotent, because the button is on a phone', async () => {
    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });

    const first = await finishBatch(worker, batch.id);
    clock.advanceHours(1);
    const second = await finishBatch(worker, batch.id);

    expect(second?.batch.finishedAt).toBe(first?.batch.finishedAt);
    expect(second?.summary).toEqual(first?.summary);
  });

  it('shows the same numbers before it closes anything', async () => {
    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });

    const preview = await previewBatch(worker, batch.id);
    expect(preview?.batch.finishedAt).toBeNull();

    const done = await finishBatch(worker, batch.id);
    expect(done?.summary).toEqual(preview?.summary);
  });
});

describe('what a scan keeps', () => {
  it('copies the order number and shop at the moment it is scanned', async () => {
    // So a matched return stays "From Return Shield" after the thirty-day
    // window has taken the parcel. See lib/views/returns.ts.
    await makeShipment({ shippingCode: CODE_A, orderNumber: '#22709', storeName: 'Don Cabello Profesional' });

    const batch = await openBatch(worker, 'outgoing');
    await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });

    const result = await getDb().execute(raw`SELECT order_number, store_name FROM scans LIMIT 1`);
    expect(rowsOf<{ order_number: string; store_name: string }>(result)[0]).toEqual({
      order_number: '#22709',
      store_name: 'Don Cabello Profesional',
    });
  });

  it('stores the parcel number and postcode printed in the bulto code', async () => {
    const batch = await openBatch(worker, 'outgoing');
    const added = await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });

    expect(added).toMatchObject({ ok: true });
    if (!added.ok) return;
    expect(added.item.parcelNo).toBe('01');
    expect(added.item.postalCode).toBe('08320');
    expect(added.item.base).toBe('PKA6TP980010152');
  });

  it('refuses something that is not a Correos number', async () => {
    const batch = await openBatch(worker, 'outgoing');
    const added = await addScan(worker, { batchId: batch.id, readId: 'r1', code: 'HELLO', source: 'typed' });

    expect(added).toEqual({ ok: false, error: 'That is not a Correos number.' });
    expect(await scanCount()).toBe(0);
  });
});

describe('the × on a row', () => {
  it('removes it from the open batch', async () => {
    const batch = await openBatch(worker, 'outgoing');
    const added = await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    if (!added.ok) throw new Error(added.error);

    expect(await removeScan(worker, added.item.id)).toBe(true);
    expect(await scanCount()).toBe(0);
  });

  it("cannot reach another worker's batch", async () => {
    const other = (await makeUser({ role: 'scanner', name: 'Other' })).id;
    const batch = await openBatch(worker, 'outgoing');
    const added = await addScan(worker, { batchId: batch.id, readId: 'r1', code: CODE_A, source: 'barcode' });
    if (!added.ok) throw new Error(added.error);

    expect(await removeScan(other, added.item.id)).toBe(false);
    expect(await scanCount()).toBe(1);
  });
});

describe('the time a scan is stamped with', () => {
  it("takes the phone's clock when it is anywhere near right", async () => {
    // So a pile that sat in IndexedDB waiting for a signal keeps the order it
    // was worked in, instead of arriving all stamped the same second.
    const at = clock.now();
    const sent = new Date(at.getTime() - 3 * HOUR).toISOString();

    expect(stampFor(sent, at).toISOString()).toBe(sent);
  });

  it("takes the server's when the phone is wrong by more than half a day", async () => {
    const at = clock.now();
    const factoryReset = new Date('1970-01-01T00:00:00Z').toISOString();

    expect(stampFor(factoryReset, at).toISOString()).toBe(at.toISOString());
    expect(stampFor(new Date(at.getTime() + CLOCK_SLACK_MS + 60_000).toISOString(), at).toISOString())
      .toBe(at.toISOString());
  });

  it("takes the server's when the phone sends nothing, or nonsense", async () => {
    const at = clock.now();
    expect(stampFor(undefined, at).toISOString()).toBe(at.toISOString());
    expect(stampFor('not a date', at).toISOString()).toBe(at.toISOString());
  });
});
