import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipmentEvents, shipments } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { parcelsView } from '@/lib/views/parcels';
import { workingDayCutoff, workingDaysSince } from '@/lib/time';
import { officeDetails } from '@/lib/messaging/build-message';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The two new flags: a parcel that has stopped moving, and a parcel waiting at
 * a post office after a missed delivery.
 *
 * Delivery takes two to three working days, so three full working days of the
 * same status means late. Weekends never count — Correos does not move parcels
 * on a Saturday, and a badge that flags a Friday label on Monday is a badge
 * the operator learns to ignore.
 */

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T10:00:00+02:00');
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

const count = (tabs: { id: string; count: number }[], id: string) =>
  tabs.find((t) => t.id === id)?.count ?? 0;

/** A parcel in `state` since `since`. */
async function inState(code: string, state: string, since: string): Promise<string> {
  const fix = await makeShipment({ shippingCode: code, state });
  await getDb().update(shipments).set({ stateSince: new Date(since) })
    .where(eq(shipments.id, fix.shipmentId));
  return fix.shipmentId;
}

/* ========================================================================== */

describe('same status for three working days', () => {
  it('does not flag Friday on Tuesday, and flags it on Wednesday', async () => {
    // Friday 2 October. Friday, Monday and Tuesday are the three working days,
    // so Wednesday is the first morning it is late.
    await inState('PS1', 'in_transit', '2026-10-02T15:00:00+02:00');

    clock.set('2026-10-06T09:00:00+02:00'); // Tuesday
    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(0);

    clock.set('2026-10-07T09:00:00+02:00'); // Wednesday
    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(1);
  });

  it('flags Monday on Thursday', async () => {
    await inState('PS2', 'in_transit', '2026-10-05T15:00:00+02:00');

    clock.set('2026-10-07T09:00:00+02:00'); // Wednesday
    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(0);

    clock.set('2026-10-08T09:00:00+02:00'); // Thursday
    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(1);
  });

  it('flags a weekend state on Thursday, because counting starts Monday', async () => {
    await inState('PS3', 'in_transit', '2026-10-03T11:00:00+02:00'); // Saturday

    clock.set('2026-10-07T09:00:00+02:00'); // Wednesday
    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(0);

    clock.set('2026-10-08T09:00:00+02:00'); // Thursday
    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(1);
  });

  it.each(['accepted', 'in_transit', 'out_for_delivery', 'failed', 'bad_address'])(
    'applies to %s',
    async (state) => {
      await inState('PS4', state, '2026-10-01T09:00:00+02:00');
      expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(1);
    },
  );

  it.each([
    ['created', 'has its own two-working-day flag'],
    ['at_office', 'has a deposit countdown, which is a better signal'],
    ['refused', 'is already going the right way'],
    ['returning', 'is already going the right way'],
    ['stale', 'is already flagged as silent'],
    ['delivered', 'is finished'],
    ['collected', 'is finished'],
    ['returned', 'is finished'],
  ])('never applies to %s, which %s', async (state) => {
    await inState('PS5', state, '2026-09-01T09:00:00+02:00');
    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(0);
  });

  it('never applies to a parcel closed by hand', async () => {
    const id = await inState('PS6', 'in_transit', '2026-09-01T09:00:00+02:00');
    await getDb().update(shipments).set({ droppedAt: clock.now(), closeReason: 'lost' })
      .where(eq(shipments.id, id));

    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(0);
  });

  it('badges the row wherever it appears', async () => {
    await inState('PS7', 'in_transit', '2026-10-02T15:00:00+02:00');

    // Found under "All not finished" rather than its own tab.
    const v = await parcelsView({ status: 'all_open' });
    expect(v.rows[0].badges).toContain('3 working days in the same status');
  });

  it('agrees with the cutoff it hands the database', () => {
    // The badge counts per row and the tab filters with one timestamp. If they
    // ever disagreed, a row would appear in the tab with no badge, or carry a
    // badge and be missing from the tab.
    for (const day of ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-12']) {
      const at = new Date(`${day}T09:00:00+02:00`);
      const cutoff = workingDayCutoff(at, 3);

      for (let back = 0; back < 16; back += 1) {
        const ref = new Date(at.getTime() - back * 86_400_000);
        expect(ref.getTime() < cutoff.getTime()).toBe(workingDaysSince(ref, at) >= 3);
      }
    }
  });

  it('falls back to the last event when the state has no start time', async () => {
    const fix = await makeShipment({ shippingCode: 'PS8', state: 'in_transit' });
    await getDb().update(shipments).set({
      stateSince: null,
      lastEventAt: new Date('2026-10-01T09:00:00+02:00'),
    }).where(eq(shipments.id, fix.shipmentId));

    expect(count((await parcelsView()).tabs, 'stuck_same_status')).toBe(1);
  });
});

/* ========================================================================== */

describe('missed delivery, waiting at the post office', () => {
  /** A parcel at the office, with whatever happened before it got there. */
  async function atOffice(
    code: string,
    before: { state: string; at: string }[],
    arrivedAt = '2026-10-05T12:00:00Z',
  ): Promise<string> {
    const fix = await makeShipment({ shippingCode: code, state: 'at_office' });

    for (const [i, e] of before.entries()) {
      await getDb().insert(shipmentEvents).values({
        shipmentId: fix.shipmentId,
        rawPayload: {},
        eventCode: `E${i}`,
        eventDesc: 'x',
        occurredAt: new Date(e.at),
        receivedAt: clock.now(),
        source: 'poll',
        mappedState: e.state,
      });
    }

    await getDb().update(shipments).set({
      officeArrivedAt: new Date(arrivedAt),
      officeDeadline: new Date('2026-10-20T21:59:59Z'),
      officeId: null,
    }).where(eq(shipments.id, fix.shipmentId));

    return fix.shipmentId;
  }

  it('includes a parcel that reached the office after a failed attempt', async () => {
    await atOffice('PM1', [{ state: 'failed', at: '2026-10-04T10:00:00Z' }]);

    const v = await parcelsView({ status: 'missed_delivery' });

    expect(v.rows).toHaveLength(1);
    expect(count(v.tabs, 'missed_delivery')).toBe(1);
  });

  it('includes one that went out for delivery with no failed event', async () => {
    // Correos does not always send a failed event. Out for delivery before the
    // office means somebody tried.
    await atOffice('PM2', [{ state: 'out_for_delivery', at: '2026-10-04T08:00:00Z' }]);

    expect(count((await parcelsView()).tabs, 'missed_delivery')).toBe(1);
  });

  it('excludes a parcel sent straight to an office', async () => {
    // Nobody missed anything: the customer chose the office. It stays under
    // "Waiting at the post office".
    await atOffice('PM3', []);

    const v = await parcelsView();
    expect(count(v.tabs, 'missed_delivery')).toBe(0);
    expect(count(v.tabs, 'at_office')).toBe(1);
  });

  it('excludes an attempt that happened AFTER it reached the office', async () => {
    // A delivery attempt from the office onwards is a different story and does
    // not mean the customer missed the original delivery.
    await atOffice('PM4', [{ state: 'failed', at: '2026-10-06T10:00:00Z' }]);
    expect(count((await parcelsView()).tabs, 'missed_delivery')).toBe(0);
  });

  it('excludes one closed by hand', async () => {
    const id = await atOffice('PM5', [{ state: 'failed', at: '2026-10-04T10:00:00Z' }]);
    await getDb().update(shipments).set({ droppedAt: clock.now(), closeReason: 'lost' })
      .where(eq(shipments.id, id));

    expect(count((await parcelsView()).tabs, 'missed_delivery')).toBe(0);
  });

  it('counts the attempts', async () => {
    await atOffice('PM6', [
      { state: 'failed', at: '2026-10-03T10:00:00Z' },
      { state: 'failed', at: '2026-10-04T10:00:00Z' },
    ]);

    const v = await parcelsView({ status: 'missed_delivery' });
    expect(v.rows[0].attempts).toBe(2);
  });

  it('carries the finished Spanish text, identical to officeDetails', async () => {
    await atOffice('PM7', [{ state: 'failed', at: '2026-10-04T10:00:00Z' }]);

    const v = await parcelsView({ status: 'missed_delivery' });
    const row = v.rows[0];

    // Built from the same function the parcel page copies, so the message is
    // the same to the character. A second copy of the wording would drift.
    const expected = officeDetails({
      firstName: 'Lucía',
      viaMarketplace: false,
      storeName: 'Cosmetics Afro Latino',
      orderNumber: row.orderNumber,
      shippingCode: 'PM7',
      officeName: null,
      officeAddress: null,
      // Correos named no office on these events, so there are no hours to
      // quote and the message leaves the sentence out rather than inventing
      // opening times nobody checked.
      officeHours: null,
      officeArrivedAt: row.atOffice ? new Date('2026-10-05T10:00:00Z') : null,
      daysAtOffice: row.atOffice?.days ?? null,
      actionUrl: null,
    });

    expect(row.messageText).toBe(expected);
  });

  it('builds a wa.me link with that text', async () => {
    await atOffice('PM8', [{ state: 'failed', at: '2026-10-04T10:00:00Z' }]);

    const v = await parcelsView({ status: 'missed_delivery' });
    const row = v.rows[0];

    expect(row.waHref).toContain('https://wa.me/34627481093?text=');
    expect(decodeURIComponent(row.waHref.split('text=')[1])).toBe(row.messageText);
  });

  it('builds a mailto with a Spanish subject and the same body, both encoded', async () => {
    await atOffice('PM9', [{ state: 'failed', at: '2026-10-04T10:00:00Z' }]);

    const v = await parcelsView({ status: 'missed_delivery' });
    const row = v.rows[0];

    expect(row.emailHref).toMatch(/^mailto:/);
    const url = new URL(row.emailHref);
    const params = new URLSearchParams(url.search);
    expect(params.get('subject')).toBe(`Tu pedido ${row.orderNumber} te espera en Correos`);
    expect(params.get('body')).toBe(row.messageText);
    // Encoded, not raw: the subject has no spaces in the href.
    expect(row.emailHref).toContain('%20');
  });

  it('gives no mailto when the order has no email', async () => {
    const id = await atOffice('PMA', [{ state: 'failed', at: '2026-10-04T10:00:00Z' }]);
    await getDb().execute(
      (await import('drizzle-orm')).sql`UPDATE orders SET email = NULL`,
    );

    const v = await parcelsView({ status: 'missed_delivery' });
    expect(v.rows[0].emailHref).toBe('');
    expect(id).toBeTruthy();
  });
});
