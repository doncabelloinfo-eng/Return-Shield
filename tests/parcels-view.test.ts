import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { eventReviewQueue, shipmentEvents, shipments } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { parcelsView, PARCEL_TABS, PAGE_SIZE } from '@/lib/views/parcels';
import { workingDaysSince, workingDayCutoff, isWorkingDay } from '@/lib/time';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The Parcels screen, by status.
 *
 * It exists because eleven parcels were tracked, correct, and on no screen:
 * Today lists what needs doing and Post office lists what is being held, so a
 * parcel moving normally through Correos was invisible. These tests are mostly
 * about the two counts that are not simply "state = X", because those are the
 * ones that can be subtly wrong and still look plausible.
 */

// 2026-10-07 is a Wednesday. Every date in this file is chosen against that.
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

/** A parcel with a Prerregistrado event at a given moment. */
async function preAdmitted(code: string, at: Date): Promise<string> {
  const fix = await makeShipment({ shippingCode: code, state: 'created' });
  await getDb().insert(shipmentEvents).values({
    shipmentId: fix.shipmentId,
    rawPayload: {},
    eventCode: 'A090000V',
    eventDesc: 'Prerregistrado',
    occurredAt: at,
    receivedAt: at,
    source: 'poll',
    mappedState: 'created',
  });
  return fix.shipmentId;
}

const count = (tabs: { id: string; count: number }[], id: string) =>
  tabs.find((t) => t.id === id)?.count ?? 0;

/* ========================================================================== */

describe('the tab counts', () => {
  it('are all zero on an empty database, and every tab is still there', async () => {
    const v = await parcelsView();

    // Every tab shows at zero on purpose: a tab that vanishes when empty means
    // the operator cannot tell "nothing is stuck" from "this screen does not
    // know about stuck".
    expect(v.tabs).toHaveLength(PARCEL_TABS.length);
    expect(v.tabs.every((t) => t.count === 0)).toBe(true);
  });

  it('counts one tab per state', async () => {
    await makeShipment({ shippingCode: 'P1', state: 'in_transit' });
    await makeShipment({ shippingCode: 'P2', state: 'in_transit' });
    await makeShipment({ shippingCode: 'P3', state: 'at_office' });
    await makeShipment({ shippingCode: 'P4', state: 'delivered' });

    const v = await parcelsView();

    expect(count(v.tabs, 'in_transit')).toBe(2);
    expect(count(v.tabs, 'at_office')).toBe(1);
    expect(count(v.tabs, 'delivered')).toBe(1);
    expect(count(v.tabs, 'failed')).toBe(0);
  });

  it('leaves finished parcels out of "all not finished"', async () => {
    await makeShipment({ shippingCode: 'P1', state: 'in_transit' });
    await makeShipment({ shippingCode: 'P2', state: 'delivered' });
    await makeShipment({ shippingCode: 'P3', state: 'collected' });
    await makeShipment({ shippingCode: 'P4', state: 'returned' });

    const v = await parcelsView();
    expect(count(v.tabs, 'all_open')).toBe(1);
  });

  it('treats a parcel closed by hand as finished', async () => {
    const fix = await makeShipment({ shippingCode: 'P1', state: 'in_transit' });
    await getDb().update(shipments).set({ droppedAt: clock.now(), closeReason: 'lost' })
      .where(eq(shipments.id, fix.shipmentId));

    const v = await parcelsView();

    // Still `in_transit` as far as Correos is concerned, and finished as far as
    // we are. The retention sweep uses the same definition.
    expect(count(v.tabs, 'all_open')).toBe(0);
    expect(count(v.tabs, 'in_transit')).toBe(1);
  });

  it('matches its own list, tab by tab', async () => {
    await makeShipment({ shippingCode: 'P1', state: 'failed' });
    await makeShipment({ shippingCode: 'P2', state: 'failed' });
    await makeShipment({ shippingCode: 'P3', state: 'at_office' });

    // The property worth protecting: a tab that says 7 and lists 5 is a screen
    // nobody trusts again. Both come from one statement for that reason.
    for (const tab of ['failed', 'at_office', 'all_open', 'delivered'] as const) {
      const v = await parcelsView({ status: tab });
      expect(v.rows).toHaveLength(count(v.tabs, tab));
      expect(v.total).toBe(count(v.tabs, tab));
    }
  });
});

/* ========================================================================== */

describe('stuck in pre-admission, counted in working days', () => {
  it('does not flag Friday\'s label on Monday', async () => {
    // Friday 2 October. Nothing could have happened over the weekend, and a
    // badge that cries wolf teaches the operator to ignore it.
    await preAdmitted('PF', new Date('2026-10-02T15:00:00+02:00'));
    clock.set('2026-10-05T09:00:00+02:00'); // Monday

    const v = await parcelsView();
    expect(count(v.tabs, 'stuck_pre_admission')).toBe(0);
  });

  it('flags Friday\'s label on Tuesday', async () => {
    await preAdmitted('PF', new Date('2026-10-02T15:00:00+02:00'));
    clock.set('2026-10-06T09:00:00+02:00'); // Tuesday

    const v = await parcelsView({ status: 'stuck_pre_admission' });

    expect(count(v.tabs, 'stuck_pre_admission')).toBe(1);
    // Friday and Monday have both passed.
    expect(v.rows[0].badges).toContain('2 working days in pre-admission');
  });

  it('flags Monday\'s label on Wednesday, not Tuesday', async () => {
    await preAdmitted('PM', new Date('2026-10-05T15:00:00+02:00'));

    clock.set('2026-10-06T09:00:00+02:00');
    expect(count((await parcelsView()).tabs, 'stuck_pre_admission')).toBe(0);

    clock.set('2026-10-07T09:00:00+02:00');
    expect(count((await parcelsView()).tabs, 'stuck_pre_admission')).toBe(1);
  });

  it('first flags a weekend label on Wednesday', async () => {
    // Saturday 3 October: counting starts on the Monday.
    await preAdmitted('PS', new Date('2026-10-03T11:00:00+02:00'));

    clock.set('2026-10-06T09:00:00+02:00'); // Tuesday — only Monday has passed
    expect(count((await parcelsView()).tabs, 'stuck_pre_admission')).toBe(0);

    clock.set('2026-10-07T09:00:00+02:00'); // Wednesday
    expect(count((await parcelsView()).tabs, 'stuck_pre_admission')).toBe(1);
  });

  it('falls back to the row\'s own age when Correos has said nothing at all', async () => {
    // No events whatsoever, which is the common case for a label that never
    // reached Correos: there is no Prerregistrado event to measure from.
    await makeShipment({
      shippingCode: 'PN',
      state: 'created',
      orderCreatedAt: new Date('2026-10-02T10:00:00+02:00'),
    });

    clock.set('2026-10-05T09:00:00+02:00');
    expect(count((await parcelsView()).tabs, 'stuck_pre_admission')).toBe(0);

    clock.set('2026-10-06T09:00:00+02:00');
    const v = await parcelsView({ status: 'stuck_pre_admission' });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].badges[0]).toContain('working days in pre-admission');
  });

  it('leaves a parcel Correos has taken alone', async () => {
    const id = await preAdmitted('PT', new Date('2026-10-01T10:00:00+02:00'));
    await getDb().update(shipments).set({ state: 'accepted' }).where(eq(shipments.id, id));

    const v = await parcelsView();
    expect(count(v.tabs, 'stuck_pre_admission')).toBe(0);
  });

  it('carries the badge into every tab the row appears in', async () => {
    await preAdmitted('PB', new Date('2026-10-02T15:00:00+02:00'));
    clock.set('2026-10-06T09:00:00+02:00');

    // Found under "All not finished" rather than its own tab, and still badged.
    const v = await parcelsView({ status: 'all_open' });
    expect(v.rows[0].badges).toContain('2 working days in pre-admission');
  });
});

describe('the working-day arithmetic itself', () => {
  it('counts Monday to Friday and nothing else', () => {
    expect(isWorkingDay(new Date('2026-10-05T12:00:00+02:00'))).toBe(true);  // Mon
    expect(isWorkingDay(new Date('2026-10-09T12:00:00+02:00'))).toBe(true);  // Fri
    expect(isWorkingDay(new Date('2026-10-10T12:00:00+02:00'))).toBe(false); // Sat
    expect(isWorkingDay(new Date('2026-10-11T12:00:00+02:00'))).toBe(false); // Sun
  });

  it('counts the event\'s own day, and only once it is over', () => {
    const fri = new Date('2026-10-02T23:55:00+02:00');
    expect(workingDaysSince(fri, new Date('2026-10-02T23:59:00+02:00'))).toBe(0);
    expect(workingDaysSince(fri, new Date('2026-10-05T00:01:00+02:00'))).toBe(1);
    expect(workingDaysSince(fri, new Date('2026-10-06T00:01:00+02:00'))).toBe(2);
  });

  it('agrees with the SQL cutoff it hands the database', () => {
    // The screen filters with one timestamp and badges with a per-row count.
    // If those two ever disagreed, a row would appear in the stuck tab without
    // a badge, or carry a badge and be missing from the tab.
    for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-12']) {
      const at = new Date(`${day}T09:00:00+02:00`);
      const cutoff = workingDayCutoff(at, 2);

      for (let back = 0; back < 14; back += 1) {
        const ref = new Date(at.getTime() - back * 86_400_000);
        const flaggedBySql = ref.getTime() < cutoff.getTime();
        const flaggedByCount = workingDaysSince(ref, at) >= 2;
        expect(flaggedBySql).toBe(flaggedByCount);
      }
    }
  });
});

/* ========================================================================== */

describe('stuck past the cleanup window', () => {
  it('shows an unfinished order from 31 days back', async () => {
    await makeShipment({
      shippingCode: 'POLD',
      state: 'in_transit',
      orderCreatedAt: new Date('2026-09-06T10:00:00+02:00'), // 31 days before
    });

    const v = await parcelsView({ status: 'stuck_30' });

    expect(v.rows).toHaveLength(1);
    expect(count(v.tabs, 'stuck_30')).toBe(1);
    expect(v.rows[0].badges.some((b) => /days, still not finished$/.test(b))).toBe(true);
  });

  it('does not show a finished one from 31 days back', async () => {
    await makeShipment({
      shippingCode: 'PDONE',
      state: 'delivered',
      orderCreatedAt: new Date('2026-09-06T10:00:00+02:00'),
    });

    expect(count((await parcelsView()).tabs, 'stuck_30')).toBe(0);
  });

  it('does not show one closed by hand', async () => {
    const fix = await makeShipment({
      shippingCode: 'PCLOSED',
      state: 'in_transit',
      orderCreatedAt: new Date('2026-09-06T10:00:00+02:00'),
    });
    await getDb().update(shipments).set({ droppedAt: clock.now(), closeReason: 'lost' })
      .where(eq(shipments.id, fix.shipmentId));

    expect(count((await parcelsView()).tabs, 'stuck_30')).toBe(0);
  });

  it('does not show one inside the window', async () => {
    await makeShipment({
      shippingCode: 'PNEW',
      state: 'in_transit',
      orderCreatedAt: new Date('2026-09-28T10:00:00+02:00'), // 9 days
    });

    expect(count((await parcelsView()).tabs, 'stuck_30')).toBe(0);
  });
});

/* ========================================================================== */

describe('to review', () => {
  it('shows a parcel whose newest event nobody has mapped', async () => {
    const fix = await makeShipment({ shippingCode: 'PREV', state: 'in_transit' });
    await getDb().insert(shipmentEvents).values({
      shipmentId: fix.shipmentId,
      rawPayload: {},
      eventCode: 'ZZ999',
      eventDesc: 'Una cosa que no conocemos',
      occurredAt: clock.now(),
      receivedAt: clock.now(),
      source: 'poll',
      mappedState: null,
    });
    await getDb().insert(eventReviewQueue).values({
      eventCode: 'ZZ999',
      eventDesc: 'Una cosa que no conocemos',
      samplePayload: {},
    });

    const v = await parcelsView({ status: 'to_review' });

    expect(v.rows).toHaveLength(1);
    expect(count(v.tabs, 'to_review')).toBe(1);
  });

  it('drops it once somebody has resolved the wording', async () => {
    const fix = await makeShipment({ shippingCode: 'PREV2', state: 'in_transit' });
    await getDb().insert(shipmentEvents).values({
      shipmentId: fix.shipmentId,
      rawPayload: {},
      eventCode: 'ZZ998',
      eventDesc: 'Otra cosa',
      occurredAt: clock.now(),
      receivedAt: clock.now(),
      source: 'poll',
      mappedState: null,
    });
    await getDb().insert(eventReviewQueue).values({
      eventCode: 'ZZ998',
      eventDesc: 'Otra cosa',
      samplePayload: {},
      resolvedAt: clock.now(),
      resolvedAs: 'in_transit',
    });

    expect(count((await parcelsView()).tabs, 'to_review')).toBe(0);
  });
});

/* ========================================================================== */

describe('search and the shop filter', () => {
  beforeEach(async () => {
    await makeShipment({
      shippingCode: 'PQ111AAAES', state: 'in_transit', storeKey: 'shop-a',
      storeName: 'Don Cabello', customerName: 'Ana Ruiz', city: 'Sevilla',
      orderNumber: 'DC-1001',
    });
    await makeShipment({
      shippingCode: 'PQ222BBBES', state: 'in_transit', storeKey: 'shop-b',
      storeName: 'Otra Tienda', customerName: 'Berta Lopez', city: 'Bilbao',
      orderNumber: 'OT-2002',
    });
  });

  it.each([
    ['a customer name', 'Ana', 'DC-1001'],
    ['an order number', 'OT-2002', 'OT-2002'],
    ['a tracking code', 'PQ111', 'DC-1001'],
    ['a town', 'Bilbao', 'OT-2002'],
  ])('searches on %s', async (_what, q, expected) => {
    const v = await parcelsView({ status: 'in_transit', q });

    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].orderNumber).toBe(expected);
  });

  it('ignores case', async () => {
    const v = await parcelsView({ status: 'in_transit', q: 'bilbao' });
    expect(v.rows).toHaveLength(1);
  });

  it('filters by shop inside the tab', async () => {
    const v = await parcelsView({ status: 'in_transit', store: 'Don Cabello' });

    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].storeName).toBe('Don Cabello');
  });

  it('narrows the counts too, so a tab cannot promise rows it will not show', async () => {
    const v = await parcelsView({ status: 'in_transit', store: 'Don Cabello' });

    expect(count(v.tabs, 'in_transit')).toBe(1);
    expect(v.total).toBe(1);
  });

  it('combines the search and the shop', async () => {
    expect((await parcelsView({ status: 'in_transit', q: 'Ana', store: 'Otra Tienda' })).rows)
      .toHaveLength(0);
  });

  it('keeps the search inside the selected tab', async () => {
    await makeShipment({
      shippingCode: 'PQ333CCCES', state: 'delivered', storeKey: 'shop-a',
      storeName: 'Don Cabello', customerName: 'Ana Ruiz', orderNumber: 'DC-3003',
    });

    // Two parcels for Ana, one in each status. The tab wins.
    const v = await parcelsView({ status: 'in_transit', q: 'Ana' });
    expect(v.rows.map((r) => r.orderNumber)).toEqual(['DC-1001']);
  });
});

/* ========================================================================== */

describe('paging', () => {
  it('serves one page at a time and says how many there are', async () => {
    for (let i = 0; i < PAGE_SIZE + 5; i += 1) {
      await makeShipment({ shippingCode: `PP${String(i).padStart(4, '0')}`, state: 'in_transit' });
    }

    const first = await parcelsView({ status: 'in_transit', page: 1 });
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.total).toBe(PAGE_SIZE + 5);
    expect(first.pages).toBe(2);

    const second = await parcelsView({ status: 'in_transit', page: 2 });
    expect(second.rows).toHaveLength(5);
    expect(second.page).toBe(2);

    // No row appears on both pages.
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(ids.size).toBe(PAGE_SIZE + 5);
  });

  it('treats a silly page number as the first one', async () => {
    await makeShipment({ shippingCode: 'PX1', state: 'in_transit' });
    expect((await parcelsView({ status: 'in_transit', page: 0 })).page).toBe(1);
    expect((await parcelsView({ status: 'in_transit', page: -3 })).page).toBe(1);
  });

  it('is empty past the end rather than wrapping round', async () => {
    await makeShipment({ shippingCode: 'PX2', state: 'in_transit' });
    expect((await parcelsView({ status: 'in_transit', page: 9 })).rows).toEqual([]);
  });
});

describe('an unknown status', () => {
  it('falls back to "all not finished" rather than showing nothing', async () => {
    await makeShipment({ shippingCode: 'PU1', state: 'in_transit' });

    // A stale bookmark or a hand-edited URL should not produce a blank screen.
    const v = await parcelsView({ status: 'not-a-real-tab' });
    expect(v.tab.id).toBe('all_open');
    expect(v.rows).toHaveLength(1);
  });
});
