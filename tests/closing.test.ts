import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { closures, orders, shipments } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { dropIt, undoDrop } from '@/lib/escalation/outcomes';
import { CLOSE_REASONS, closeReasonLabel, isCloseReason, noteRequiredFor } from '@/lib/escalation/close-reasons';
import { closuresView, closureCount, monthKey } from '@/lib/views/closures';
import { parcelsView } from '@/lib/views/parcels';
import { runCleanup, cutoffFor } from '@/lib/cleanup';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * Closing a parcel by hand, and the record it leaves.
 *
 * "Stop chasing this one" used to write a timestamp and nothing else. A month
 * later the system could say how many parcels had been given up on and never
 * why — a parcel Correos lost and one the customer had all along were the same
 * row — and once the retention window shipped, even that much would have
 * vanished after thirty days.
 */

const NOW = '2026-10-07T10:00:00+02:00';
let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

const row = async (id: string) =>
  (await getDb().select().from(shipments).where(eq(shipments.id, id)))[0];

/* ========================================================================== */

describe('the reason is required', () => {
  it('refuses a reason that is not one of the four', async () => {
    const fix = await makeShipment({ shippingCode: 'PC1', state: 'at_office' });

    await expect(dropIt(fix.shipmentId, { reason: 'because' as never }))
      .rejects.toThrow(/not one of/);

    // And nothing was written: no half-closed parcel, no stray closure row.
    expect((await row(fix.shipmentId)).droppedAt).toBeNull();
    expect(await closureCount()).toBe(0);
  });

  it('refuses "Other" with no note', async () => {
    const fix = await makeShipment({ shippingCode: 'PC2', state: 'at_office' });

    await expect(dropIt(fix.shipmentId, { reason: 'other' })).rejects.toThrow(/needs a note/);
    await expect(dropIt(fix.shipmentId, { reason: 'other', note: '   ' })).rejects.toThrow(/needs a note/);

    expect((await row(fix.shipmentId)).droppedAt).toBeNull();
    expect(await closureCount()).toBe(0);
  });

  it('accepts "Other" with a note', async () => {
    const fix = await makeShipment({ shippingCode: 'PC3', state: 'at_office' });

    await dropIt(fix.shipmentId, { reason: 'other', note: 'Customer collected from the warehouse' });

    const r = await row(fix.shipmentId);
    expect(r.closeReason).toBe('other');
    expect(r.closeNote).toBe('Customer collected from the warehouse');
  });

  it('lets the other three stand without a note', async () => {
    for (const reason of ['lost', 'delivered_by_hand', 'returned_received'] as const) {
      expect(noteRequiredFor(reason)).toBe(false);
    }
    expect(noteRequiredFor('other')).toBe(true);
  });

  it.each(['lost', 'delivered_by_hand', 'returned_received', 'other'])('knows %s', (r) => {
    expect(isCloseReason(r)).toBe(true);
  });

  it('does not know anything else', () => {
    expect(isCloseReason('lost_in_post')).toBe(false);
    expect(isCloseReason('')).toBe(false);
  });
});

/* ========================================================================== */

describe('what closing writes', () => {
  it('records the reason, the note, who and when on the shipment', async () => {
    const fix = await makeShipment({ shippingCode: 'PW1', state: 'failed' });

    const result = await dropIt(
      fix.shipmentId,
      { reason: 'lost', note: 'Correos cannot find it' },
      undefined,
    );

    const r = await row(fix.shipmentId);
    expect(r.droppedAt).not.toBeNull();
    expect(r.closeReason).toBe('lost');
    expect(r.closeNote).toBe('Correos cannot find it');
    // The toast says which reason, so the operator can see they picked right.
    expect(result.toast).toContain('Lost');
  });

  it('writes one closures row, with no customer details', async () => {
    const fix = await makeShipment({
      shippingCode: 'PW2',
      state: 'at_office',
      customerName: 'Lucía Fernández Ortiz',
      storeName: 'Don Cabello',
      valueCents: 4490,
      orderNumber: 'DC-5005',
      orderCreatedAt: new Date('2026-09-27T10:00:00+02:00'),
    });

    await dropIt(fix.shipmentId, { reason: 'lost' });

    const [c] = await getDb().select().from(closures);
    expect(c.orderNumber).toBe('DC-5005');
    expect(c.storeName).toBe('Don Cabello');
    expect(c.shippingCode).toBe('PW2');
    expect(c.reason).toBe('lost');
    expect(c.valueCents).toBe(4490);
    expect(c.daysSinceOrder).toBe(10);
    expect(c.undoneAt).toBeNull();

    // A permanent record of somebody's name, phone and address is a liability
    // rather than an asset, so the table has nowhere to put one.
    expect(JSON.stringify(c)).not.toContain('Lucía');
    expect(JSON.stringify(c)).not.toContain('627');
  });

  it('stops the escalation ladder, as it always did', async () => {
    const fix = await makeShipment({ shippingCode: 'PW3', state: 'at_office' });
    await dropIt(fix.shipmentId, { reason: 'lost' });

    // `droppedAt` stays the one answer to "is it closed", so code that predates
    // the reason columns keeps working unchanged.
    expect((await row(fix.shipmentId)).droppedAt).not.toBeNull();
  });
});

describe('undo', () => {
  it('reopens the parcel and marks the closure undone', async () => {
    const fix = await makeShipment({ shippingCode: 'PU1', state: 'at_office' });
    await dropIt(fix.shipmentId, { reason: 'lost' });

    await undoDrop(fix.shipmentId);

    const r = await row(fix.shipmentId);
    expect(r.droppedAt).toBeNull();
    expect(r.closeReason).toBeNull();
    expect(r.closeNote).toBeNull();

    // The row is kept rather than deleted: that somebody wrote a parcel off
    // and then changed their mind is the one fact worth keeping here.
    const [c] = await getDb().select().from(closures);
    expect(c.undoneAt).not.toBeNull();
  });

  it('leaves an undone closure out of every count', async () => {
    const a = await makeShipment({ shippingCode: 'PU2', state: 'at_office' });
    const b = await makeShipment({ shippingCode: 'PU3', state: 'at_office' });

    await dropIt(a.shipmentId, { reason: 'lost' });
    await dropIt(b.shipmentId, { reason: 'returned_received' });
    await undoDrop(a.shipmentId);

    expect(await closureCount()).toBe(1);

    const view = await closuresView({ at: clock.now() });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].reason).toBe('returned_received');
    expect(view.counts.find((c) => c.reason === 'lost')?.allTime).toBe(0);
  });

  it('only undoes the live closure when a parcel was closed twice', async () => {
    const fix = await makeShipment({ shippingCode: 'PU4', state: 'at_office' });

    await dropIt(fix.shipmentId, { reason: 'lost' });
    await undoDrop(fix.shipmentId);
    await dropIt(fix.shipmentId, { reason: 'returned_received' });

    const rows = await getDb().select().from(closures);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.undoneAt === null)).toHaveLength(1);
    expect(await closureCount()).toBe(1);
  });
});

/* ========================================================================== */

describe('the Closed by hand tab', () => {
  async function close(code: string, reason: Parameters<typeof dropIt>[1]['reason'], store = 'Don Cabello') {
    const fix = await makeShipment({
      shippingCode: code, state: 'at_office', storeName: store,
      storeKey: store === 'Don Cabello' ? 'dc' : 'other-shop',
    });
    // "Other" will not go through without a note, so the helper supplies one.
    await dropIt(fix.shipmentId, { reason, note: reason === 'other' ? 'see the thread' : '' });
    return fix;
  }

  it('counts per reason, for the window and for all time', async () => {
    await close('PT1', 'lost');
    await close('PT2', 'lost');
    await close('PT3', 'delivered_by_hand');

    const view = await closuresView({ at: clock.now() });

    const lost = view.counts.find((c) => c.reason === 'lost')!;
    expect(lost.recent).toBe(2);
    expect(lost.allTime).toBe(2);
    expect(view.counts.find((c) => c.reason === 'delivered_by_hand')?.recent).toBe(1);
    // Every reason appears, including the ones at zero.
    expect(view.counts).toHaveLength(4);
    expect(view.counts.find((c) => c.reason === 'other')?.allTime).toBe(0);
    expect(view.recentTotal).toBe(3);
  });

  it('counts older write-offs in all time but not in the window', async () => {
    const fix = await makeShipment({ shippingCode: 'PT4', state: 'at_office' });
    await dropIt(fix.shipmentId, { reason: 'lost' });
    // Backdated past the window: the parcel may be long gone, the record is not.
    await getDb().update(closures).set({ closedAt: new Date('2026-07-01T10:00:00+02:00') });

    const view = await closuresView({ at: clock.now() });
    const lost = view.counts.find((c) => c.reason === 'lost')!;

    expect(lost.recent).toBe(0);
    expect(lost.allTime).toBe(1);
  });

  it('filters by reason', async () => {
    await close('PT5', 'lost');
    await close('PT6', 'returned_received');

    const view = await closuresView({ reason: 'lost', at: clock.now() });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].shippingCode).toBe('PT5');
  });

  it('filters by shop', async () => {
    await close('PT7', 'lost', 'Don Cabello');
    await close('PT8', 'lost', 'Otra Tienda');

    const view = await closuresView({ store: 'Otra Tienda', at: clock.now() });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].storeName).toBe('Otra Tienda');
  });

  it('filters by month', async () => {
    const fix = await makeShipment({ shippingCode: 'PT9', state: 'at_office' });
    await dropIt(fix.shipmentId, { reason: 'lost' });
    await getDb().update(closures).set({ closedAt: new Date('2026-08-15T10:00:00+02:00') });

    expect((await closuresView({ month: '2026-08', at: clock.now() })).rows).toHaveLength(1);
    expect((await closuresView({ month: '2026-10', at: clock.now() })).rows).toHaveLength(0);
    // A nonsense month is ignored rather than returning nothing at all.
    expect((await closuresView({ month: 'banana', at: clock.now() })).rows).toHaveLength(1);
    expect(monthKey(new Date('2026-08-15T10:00:00+02:00'))).toBe('2026-08');
  });

  it('is the tab count on the Parcels screen', async () => {
    await close('PTA', 'lost');
    await close('PTB', 'other');

    const v = await parcelsView({ at: clock.now() });
    expect(v.tabs.find((t) => t.id === 'closed')?.count).toBe(1 + 1);
  });

  it('shows the English label for every reason', async () => {
    const view = await closuresView({ at: clock.now() });
    expect(view.counts.map((c) => c.label)).toEqual([
      'Lost',
      'Delivered (confirmed by hand)',
      'Returned (received back)',
      'Other',
    ]);
  });
});

/* ========================================================================== */

describe('the record outliving the parcel', () => {
  it('survives the cleanup that deletes the parcel', async () => {
    const fix = await makeShipment({
      shippingCode: 'POUT',
      state: 'at_office',
      orderNumber: 'DC-9009',
      orderCreatedAt: new Date(cutoffFor(clock.now(), 31).getTime() + 3_600_000),
    });

    await dropIt(fix.shipmentId, { reason: 'lost', note: 'never scanned again' });

    // A parcel closed by hand counts as finished, so it goes 30 days after its
    // order day like any other.
    const report = await runCleanup(clock.now());
    expect(report.orders).toBe(1);
    expect(await getDb().select().from(orders)).toHaveLength(0);

    const [c] = await getDb().select().from(closures);
    expect(c).toBeDefined();
    expect(c.orderNumber).toBe('DC-9009');
    expect(c.reason).toBe('lost');
    expect(c.note).toBe('never scanned again');
    // The link went null rather than taking the record with the parcel.
    expect(c.shipmentId).toBeNull();

    // And it is still counted, which is the entire point.
    expect(await closureCount()).toBe(1);
    const view = await closuresView({ at: clock.now() });
    expect(view.rows[0].shipmentId).toBeNull();
    expect(view.rows[0].orderNumber).toBe('DC-9009');
  });
});

describe('closeReasonLabel', () => {
  it('reads in English', () => {
    expect(closeReasonLabel('lost')).toBe('Lost');
    expect(closeReasonLabel('delivered_by_hand')).toBe(CLOSE_REASONS.delivered_by_hand.label);
  });

  it('is honest about a parcel closed before reasons existed', () => {
    // Inventing a reason for one of those would be worse than saying so.
    expect(closeReasonLabel(null)).toBe('No reason recorded');
    expect(closeReasonLabel('')).toBe('No reason recorded');
  });
});
