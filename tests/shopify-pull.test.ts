import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { activity, orders, shipments, stores, tasks } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { nextPageUrl, pullStore, PAGE_LIMIT } from '@/lib/carriers/shopify/pull';
import { settleHistory } from '@/lib/shipments/ingest';
import { cutoffFor } from '@/lib/cleanup';
import { resetDb, closeDb } from './helpers/db';

/**
 * Pulling the last thirty days out of Shopify.
 *
 * The hourly check had two bugs that cost orders silently, and both are the
 * reason these tests exist. It asked for `limit: 100` and read the FIRST PAGE
 * ONLY — at a thousand parcels a day, two days of orders is several hundred,
 * so it was looking at a fraction and reporting success. And it filtered
 * `fulfillment_status=shipped`, which leaves out partially fulfilled orders
 * whose posted parcel is as real as any other.
 *
 * Neither failure announces itself. A short page just ends.
 */

const STORE = 'pulltest';
const TOKEN_VAR = 'SHOPIFY_PULLTEST_ACCESS_TOKEN';
const DOMAIN = 'pull-test.myshopify.com';

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T10:00:00+02:00');
  clock.install();
  process.env[TOKEN_VAR] = 'a-token';

  await getDb().insert(stores).values({
    key: STORE, name: 'Pull Test', platform: 'shopify', ingest: 'auto', shopDomain: DOMAIN,
  });
});

afterAll(async () => {
  resetClock();
  delete process.env[TOKEN_VAR];
  await closeDb();
});

/** A Shopify order with one Correos fulfilment. */
function order(
  n: number,
  opts: { shippedAt?: string; company?: string; tracking?: string } = {},
) {
  return {
    id: 1000 + n,
    name: `#${2000 + n}`,
    created_at: '2026-10-01T09:00:00Z',
    total_price: '44.90',
    shipping_address: { name: `Customer ${n}`, phone: '+34600111222', city: 'Madrid' },
    fulfillments: [{
      id: 5000 + n,
      tracking_company: opts.company ?? 'Correos',
      tracking_number: opts.tracking ?? `PQ${String(n).padStart(9, '0')}ES`,
      created_at: opts.shippedAt ?? '2026-10-05T11:00:00Z',
    }],
  };
}

/** A fake Shopify that serves pages and records what was asked. */
function shopify(pages: { orders: unknown[]; next?: string }[]) {
  const asked: string[] = [];
  let i = 0;

  const fetchImpl = (async (url: unknown) => {
    asked.push(String(url));
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return new Response(JSON.stringify({ orders: page.orders }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...(page.next ? { link: `<${page.next}>; rel="next"` } : {}),
      },
    });
  }) as unknown as typeof fetch;

  return { asked, fetchImpl };
}

/* ========================================================================== */

describe('following Shopify\'s Link header', () => {
  it('finds the next page', () => {
    expect(nextPageUrl('<https://x/admin/api/2026-10/orders.json?page_info=abc>; rel="next"'))
      .toBe('https://x/admin/api/2026-10/orders.json?page_info=abc');
  });

  it('finds next among several links', () => {
    const header = '<https://x/prev>; rel="previous", <https://x/next>; rel="next"';
    expect(nextPageUrl(header)).toBe('https://x/next');
  });

  it('is null at the end, which is the only signal there is', () => {
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl('<https://x/prev>; rel="previous"')).toBeNull();
  });
});

describe('paging', () => {
  it('follows Link to the end', async () => {
    const { asked, fetchImpl } = shopify([
      { orders: [order(1), order(2)], next: 'https://x/page2' },
      { orders: [order(3)], next: 'https://x/page3' },
      { orders: [order(4)] },
    ]);

    const report = await pullStore(STORE, { fetchImpl });

    expect(report.pages).toBe(3);
    expect(report.checked).toBe(4);
    expect(report.added).toBe(4);
    expect(asked).toHaveLength(3);
    expect(asked[1]).toBe('https://x/page2');
    expect(asked[2]).toBe('https://x/page3');
  });

  it('asks for 250 a page, not 100', async () => {
    const { asked, fetchImpl } = shopify([{ orders: [] }]);
    await pullStore(STORE, { fetchImpl });

    const url = new URL(asked[0]);
    expect(url.searchParams.get('limit')).toBe(String(PAGE_LIMIT));
    expect(PAGE_LIMIT).toBe(250);
  });

  it('asks for every fulfilment status, not only shipped', async () => {
    const { asked, fetchImpl } = shopify([{ orders: [] }]);
    await pullStore(STORE, { fetchImpl });

    // A partially fulfilled order is `partial`, and its posted parcel is as
    // real as any other. `shipped` left those out.
    expect(new URL(asked[0]).searchParams.get('fulfillment_status')).toBe('any');
    expect(new URL(asked[0]).searchParams.get('status')).toBe('any');
  });

  it('stops when the budget runs out, between pages', async () => {
    const { fetchImpl } = shopify([
      { orders: [order(1)], next: 'https://x/2' },
      { orders: [order(2)], next: 'https://x/3' },
      { orders: [order(3)], next: 'https://x/4' },
    ]);

    const report = await pullStore(STORE, { fetchImpl, budgetMs: -1 });

    // Checked before the first page, so nothing is half-read.
    expect(report.pages).toBe(0);
    expect(report.stoppedEarly).toContain('press it again');
  });

  it('reports a page that failed rather than pretending it ended', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const report = await pullStore(STORE, { fetchImpl });

    expect(report.stoppedEarly).toContain('503');
    expect(report.added).toBe(0);
  });
});

describe('what it keeps', () => {
  it('keeps only Correos fulfilments', async () => {
    // The tracking number has to be non-Correos too: `isCorreos` recognises a
    // Correos domestic code (two letters, digits, ES) whatever the company
    // field says, which is right — a Correos code is a Correos code.
    const { fetchImpl } = shopify([{
      orders: [order(1), order(2, { company: 'SEUR', tracking: '1234567890123' })],
    }]);

    const report = await pullStore(STORE, { fetchImpl });

    expect(report.added).toBe(1);
    expect(report.notCorreos).toBe(1);
  });

  it('leaves TikTok parcels synced into Shopify alone', async () => {
    // They carry PKA6TP… codes with no carrier name, so `isCorreos` does not
    // recognise them — deliberately, because they come in through the file
    // upload and recognising them here would ingest them twice.
    const { fetchImpl } = shopify([{
      orders: [{
        ...order(9),
        fulfillments: [{
          id: 1, tracking_company: '', tracking_number: 'PKA6TP9800000000000001X',
          created_at: '2026-10-05T11:00:00Z',
        }],
      }],
    }]);

    const report = await pullStore(STORE, { fetchImpl });
    expect(report.added).toBe(0);
    expect(report.notCorreos).toBe(1);
  });

  it('leaves a fulfilment posted before the window alone', async () => {
    // `updated_at_min` is about the ORDER record. An order touched yesterday
    // can carry a parcel posted six weeks ago, and pulling that in would hand
    // it straight to tonight's cleanup.
    const old = new Date(cutoffFor(clock.now()).getTime() - 5 * 86_400_000).toISOString();
    const { fetchImpl } = shopify([{ orders: [order(1, { shippedAt: old })] }]);

    const report = await pullStore(STORE, { fetchImpl });

    expect(report.added).toBe(0);
    expect(report.outsideWindow).toBe(1);
  });

  it('never asks for anything older than the retention window', async () => {
    const { asked, fetchImpl } = shopify([{ orders: [] }]);
    // Sixty days would be a thousand parcels arriving and vanishing overnight.
    await pullStore(STORE, {
      fetchImpl,
      from: new Date(clock.now().getTime() - 60 * 86_400_000),
    });

    const from = new Date(new URL(asked[0]).searchParams.get('updated_at_min')!);
    expect(from.getTime()).toBe(cutoffFor(clock.now()).getTime());
  });

  it('takes the ship date from the fulfilment, not the order', async () => {
    const { fetchImpl } = shopify([{
      orders: [order(1, { shippedAt: '2026-10-05T11:00:00Z' })],
    }]);

    await pullStore(STORE, { fetchImpl });

    const [row] = await getDb().select().from(shipments);
    // The order was created on the 1st and posted on the 5th. Four days of
    // retention window apart, and the ship date is what the window counts.
    expect(row.shippedAt?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
  });
});

describe('pressing it twice', () => {
  it('adds nothing the second time', async () => {
    const pages = [{ orders: [order(1), order(2)] }];

    const first = await pullStore(STORE, { fetchImpl: shopify(pages).fetchImpl });
    expect(first.added).toBe(2);

    const second = await pullStore(STORE, { fetchImpl: shopify(pages).fetchImpl });
    expect(second.added).toBe(0);
    expect(second.alreadyHad).toBe(2);

    expect(await getDb().select().from(shipments)).toHaveLength(2);
  });

  it('corrects a ship date that was only a fallback', async () => {
    // Everything that predates the column was backfilled with `created_at`.
    // The pull is how those get their real fulfilment date.
    await pullStore(STORE, { fetchImpl: shopify([{ orders: [order(1)] }]).fetchImpl });
    await getDb().update(shipments).set({ shippedAt: new Date('2000-01-01T00:00:00Z') });

    await pullStore(STORE, {
      fetchImpl: shopify([{ orders: [order(1, { shippedAt: '2026-10-06T08:00:00Z' })] }]).fetchImpl,
    });

    const [row] = await getDb().select().from(shipments);
    expect(row.shippedAt?.toISOString()).toBe('2026-10-06T08:00:00.000Z');
  });

  it('says one line per pull, not one per order', async () => {
    const { fetchImpl } = shopify([{ orders: [order(1), order(2), order(3)] }]);
    await pullStore(STORE, { fetchImpl });

    const lines = await getDb().select().from(activity);
    // One, not three. The ticker holds twenty-four hours; a thousand lines of
    // history would bury a whole day of real events.
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Pulled 3 parcels from the last 30 days of Pull Test');
    // And it links to a parcel, so the line goes somewhere.
    expect(lines[0].shipmentId).not.toBeNull();
  });

  it('says nothing at all when it found nothing', async () => {
    const { fetchImpl } = shopify([{ orders: [] }]);
    await pullStore(STORE, { fetchImpl });

    expect(await getDb().select().from(activity)).toHaveLength(0);
  });
});

describe('a store with no token', () => {
  it('says so instead of failing', async () => {
    delete process.env[TOKEN_VAR];
    const report = await pullStore(STORE, { fetchImpl: shopify([{ orders: [] }]).fetchImpl });

    expect(report.added).toBe(0);
    expect(report.stoppedEarly).toContain('Admin API token');
    process.env[TOKEN_VAR] = 'a-token';
  });
});

/* ========================================================================== */

describe('history arriving quietly', () => {
  /** A pulled parcel, already in whatever state its history left it. */
  async function pulled(state: string): Promise<string> {
    const { fetchImpl } = shopify([{ orders: [order(1)] }]);
    await pullStore(STORE, { fetchImpl });
    const [row] = await getDb().select().from(shipments);
    await getDb().update(shipments).set({ state }).where(eq(shipments.id, row.id));
    // The pull's own line is not what these tests are about.
    await getDb().delete(activity);
    return row.id;
  }

  it('gives a parcel delivered before the pull no line and no task', async () => {
    const id = await pulled('delivered');

    const outcome = await settleHistory(id);

    expect(outcome).toBe('finished');
    // It was delivered a fortnight ago. Saying so now is news about nothing,
    // and a task for it is a task nobody can do.
    expect(await getDb().select().from(activity)).toHaveLength(0);
    expect(await getDb().select().from(tasks)).toHaveLength(0);
  });

  it.each(['collected', 'returned'])('does the same for %s', async (state) => {
    const id = await pulled(state);
    expect(await settleHistory(id)).toBe('finished');
    expect(await getDb().select().from(tasks)).toHaveLength(0);
  });

  it('gives a parcel at the office its current step, once', async () => {
    const id = await pulled('at_office');

    const outcome = await settleHistory(id);

    expect(outcome).toBe('needs_person');
    // What a new event of that state would give it today — one line.
    const lines = await getDb().select().from(activity);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain('now at');
  });

  it('does not send the reminders that were due in the past', async () => {
    const id = await pulled('at_office');
    await settleHistory(id);

    const fires = await getDb().select().from(
      (await import('@/db/schema')).escalationFires,
    );

    // Every message rung whose due time has gone by is marked fired. Without
    // this the first tick would send four reminders at once about a parcel the
    // customer may already have collected.
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((f) => f.silencedAt !== null)).toBe(true);
  });

  it('leaves a parcel that is simply moving alone', async () => {
    const id = await pulled('in_transit');

    expect(await settleHistory(id)).toBe('quiet');
    expect(await getDb().select().from(activity)).toHaveLength(0);
    expect(await getDb().select().from(tasks)).toHaveLength(0);
  });
});
