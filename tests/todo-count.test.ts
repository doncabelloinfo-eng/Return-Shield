import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipments, tasks } from '@/db/schema';
import { TestClock, resetClock, MINUTE } from '@/lib/clock';
import { actionable } from '@/lib/escalation/decide';
import { loadRows } from '@/lib/views/rows';
import { todoCount } from '@/lib/views/todo';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * "N to do" in the top bar, and the one thing that has to stay true about it.
 *
 * WHAT IT COST BEFORE. The panel layout — which wraps every screen — called
 * `loadRows()` to get this number. That selects EVERY shipment with no WHERE,
 * delivered and closed ones included, then runs two more queries over every id
 * it got back, then builds the full row for each: the Spanish office wording,
 * the WhatsApp link, the mailto, the contact line. On every page view. To
 * produce one integer. It was among the queries Supabase was refusing when the
 * pooler filled up, and it got slower every day the table grew.
 *
 * WHAT MUST NOT CHANGE. The number. `todoCount` prunes in SQL only what
 * provably cannot be actionable and leaves every decision to `actionable()`,
 * the same function Today uses — so every test here asserts the count against
 * what Today itself lists, as well as against a number. If those two ever part
 * company, the top bar is lying about the screen one tap away.
 */

let clock: TestClock;
const NOW = '2026-10-07T10:00:00+02:00';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

/** What Today lists, by the long route the top bar used to take. */
async function whatTodayLists(): Promise<number> {
  return actionable(await loadRows({ at: clock.now() }), clock.now()).length;
}

async function expectAgreement(expected: number): Promise<void> {
  const [counted, listed] = await Promise.all([
    todoCount({ at: clock.now() }),
    whatTodayLists(),
  ]);
  expect(counted).toBe(expected);
  expect(counted).toBe(listed);
}

async function openTask(
  shipmentId: string,
  type: 'call' | 'contact' | 'address_fix' | 'chase_carrier' | 'insight',
): Promise<void> {
  await getDb().insert(tasks).values({
    shipmentId, type, reason: 'test', label: 'Ring them about the parcel',
  });
}

describe('the to-do count', () => {
  it('is nothing on an empty database', async () => {
    await expectAgreement(0);
  });

  it('ignores a parcel moving normally with nothing to do about it', async () => {
    // The common case, and the reason the old query was such bad value: this
    // row was loaded, mapped and decided on every page view to be ignored.
    await makeShipment({ shippingCode: 'PT01', state: 'in_transit' });
    await makeShipment({ shippingCode: 'PT02', state: 'at_office' });
    await expectAgreement(0);
  });

  it('counts a parcel with somebody to ring', async () => {
    const fix = await makeShipment({ shippingCode: 'PT03', state: 'at_office' });
    await openTask(fix.shipmentId, 'call');
    await expectAgreement(1);
  });

  it('counts a parcel coming back that has not been restocked', async () => {
    await makeShipment({ shippingCode: 'PT04', state: 'returning' });
    await expectAgreement(1);
  });

  it('stops counting it once the stock has been put back', async () => {
    const fix = await makeShipment({ shippingCode: 'PT05', state: 'returned' });
    await expectAgreement(1);

    await getDb().update(shipments).set({ restockedAt: clock.now() })
      .where(eq(shipments.id, fix.shipmentId));
    await expectAgreement(0);
  });

  it('counts a parcel waiting on a redirection', async () => {
    const fix = await makeShipment({ shippingCode: 'PT06', state: 'failed' });
    await getDb().update(shipments).set({ redirectPending: true })
      .where(eq(shipments.id, fix.shipmentId));
    await expectAgreement(1);
  });

  it('does not count one that is snoozed, and counts it again when the snooze runs out', async () => {
    const fix = await makeShipment({ shippingCode: 'PT07', state: 'at_office' });
    await openTask(fix.shipmentId, 'call');
    await getDb().update(shipments)
      .set({ mutedUntil: new Date(clock.now().getTime() + 30 * MINUTE) })
      .where(eq(shipments.id, fix.shipmentId));

    await expectAgreement(0);

    clock.set('2026-10-07T11:00:00+02:00');
    await expectAgreement(1);
  });

  it('does not count one closed by hand', async () => {
    const fix = await makeShipment({ shippingCode: 'PT08', state: 'at_office' });
    await openTask(fix.shipmentId, 'call');
    await getDb().update(shipments).set({ droppedAt: clock.now(), closeReason: 'lost' })
      .where(eq(shipments.id, fix.shipmentId));
    await expectAgreement(0);
  });

  it('does not count a task somebody has already dealt with', async () => {
    const fix = await makeShipment({ shippingCode: 'PT09', state: 'at_office' });
    await openTask(fix.shipmentId, 'call');
    await getDb().update(tasks).set({ status: 'done', closedAt: clock.now() })
      .where(eq(tasks.shipmentId, fix.shipmentId));
    await expectAgreement(0);
  });

  it('agrees with Today across a mixed table', async () => {
    // Everything at once, which is the only shape that would catch a WHERE
    // clause that prunes one row too many.
    const call = await makeShipment({ shippingCode: 'PT10', state: 'at_office' });
    await openTask(call.shipmentId, 'call');

    const chase = await makeShipment({ shippingCode: 'PT11', state: 'in_transit' });
    await openTask(chase.shipmentId, 'chase_carrier');

    const address = await makeShipment({ shippingCode: 'PT12', state: 'bad_address' });
    await openTask(address.shipmentId, 'address_fix');

    await makeShipment({ shippingCode: 'PT13', state: 'returning' });
    await makeShipment({ shippingCode: 'PT14', state: 'refused' });

    // Noise that must not be counted.
    await makeShipment({ shippingCode: 'PT15', state: 'delivered' });
    await makeShipment({ shippingCode: 'PT16', state: 'collected' });
    await makeShipment({ shippingCode: 'PT17', state: 'in_transit' });
    await makeShipment({ shippingCode: 'PT18', state: 'created' });

    await expectAgreement(5);
  });
});
