import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { getDb } from '@/db';
import { activity, orders, shipments, stores } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestShopifyOrder, type ShopifyOrderPayload } from '@/lib/carriers/shopify/ingest';
import {
  DEFAULT_ORDER_SOURCES, SOURCE_BY_APP_ID, TIKTOK_TAG_PREFIX,
  allowedSources, hasTikTokTag, tiktokOrderIdFromTags, verdictFor,
} from '@/lib/carriers/shopify/channel';
import { pullStore } from '@/lib/carriers/shopify/pull';
import { POST as webhook } from '@/app/api/webhooks/shopify/[store]/route';
import { resetDb, closeDb } from './helpers/db';

/**
 * Only the Online Store and Draft Orders come from Shopify.
 *
 * WHAT WENT WRONG. The TikTok sales channel is installed on `doncabellopro`,
 * so every TikTok Shop order is ALSO a Shopify order — 235 of the store's last
 * 250, against 12 from the Online Store and 3 Draft Orders. The webhook, the
 * hourly backfill and the thirty-day pull all took them.
 *
 * A shipment is unique by its tracking code, so whichever source arrived first
 * owned the parcel, and the webhook fires at fulfilment — so Shopify usually
 * won. The parcel then sat under "Don Cabello Profesional" with a #22xxx
 * Shopify order number, the TikTok upload skipped it as a duplicate, and it
 * never appeared under "TikTok Shop ES", which is the filter the TikTok Shop
 * team works from. 92 consecutive order numbers of that store's 213 parcels
 * were in that state.
 *
 * ONE CHECK, in `ingestShopifyOrder`, because that is the one function all
 * three paths go through. These tests are mostly about what it does NOT write:
 * a refused order must leave no order row, no shipment and no ticker line, or
 * the shop filter is wrong again by a different route.
 */

const STORE = 'chantest';
const SECRET_VAR = 'SHOPIFY_CHANTEST_WEBHOOK_SECRET';
const SOURCES_VAR = 'SHOPIFY_CHANTEST_ORDER_SOURCES';
const TOKEN_VAR = 'SHOPIFY_CHANTEST_ACCESS_TOKEN';
const SECRET = 'a-webhook-secret';

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-15T10:00:00+02:00');
  clock.install();
  process.env[SECRET_VAR] = SECRET;
  process.env[TOKEN_VAR] = 'a-token';
  delete process.env[SOURCES_VAR];

  await getDb().insert(stores).values({
    key: STORE, name: 'Chan Test', platform: 'shopify', ingest: 'auto',
    shopDomain: 'chan-test.myshopify.com',
  });
});

afterAll(async () => {
  resetClock();
  delete process.env[SECRET_VAR];
  delete process.env[TOKEN_VAR];
  delete process.env[SOURCES_VAR];
  await closeDb();
});

/** A Shopify order with one Correos fulfilment, from whichever channel. */
function order(opts: {
  n?: number;
  source?: string | null;
  appId?: number | string | null;
  tags?: string | string[] | null;
} = {}): ShopifyOrderPayload {
  const n = opts.n ?? 1;
  return {
    id: 7000 + n,
    name: `#${22700 + n}`,
    ...(opts.source === undefined ? { source_name: 'web' } : { source_name: opts.source }),
    ...(opts.appId === undefined ? {} : { app_id: opts.appId }),
    ...(opts.tags === undefined ? {} : { tags: opts.tags }),
    created_at: '2026-10-13T09:00:00Z',
    total_price: '41.90',
    shipping_address: { name: 'Lucía Fernández', phone: '+34627481093', city: 'Getafe' },
    fulfillments: [{
      id: 9000 + n,
      tracking_company: 'Correos',
      tracking_number: `PQ3000${String(n).padStart(5, '0')}ES`,
      created_at: '2026-10-14T11:00:00Z',
    }],
  };
}

/** A real TikTok-channel order, as this store sends them. */
function tiktokOrder(n = 1): ShopifyOrderPayload {
  return {
    ...order({ n, source: 'tiktok', appId: 4383523 }),
    tags: ['Shipped by Seller', `${TIKTOK_TAG_PREFIX}57696709762348464${n}`, 'NORMAL'],
  };
}

async function counts(): Promise<{ orders: number; shipments: number; activity: number }> {
  const [o, s, a] = await Promise.all([
    getDb().select({ id: orders.id }).from(orders),
    getDb().select({ id: shipments.id }).from(shipments),
    getDb().select({ id: activity.id }).from(activity),
  ]);
  return { orders: o.length, shipments: s.length, activity: a.length };
}

/* ======================================================== the rule itself */

describe('which channels we take', () => {
  it('is the Online Store and Draft Orders, unless told otherwise', () => {
    expect(allowedSources(STORE)).toEqual([...DEFAULT_ORDER_SOURCES]);
    expect([...DEFAULT_ORDER_SOURCES]).toEqual(['web', 'shopify_draft_order']);
  });

  it('reads the store own allowlist when it is set', () => {
    process.env[SOURCES_VAR] = 'web, 2329312 ,SHOPIFY_DRAFT_ORDER';
    expect(allowedSources(STORE)).toEqual(['web', '2329312', 'shopify_draft_order']);
    // Per store: a second shop's list is its own business.
    expect(allowedSources('other-shop')).toEqual([...DEFAULT_ORDER_SOURCES]);
  });

  it('reads the TikTok order id out of the tags Shopify sends', () => {
    expect(tiktokOrderIdFromTags(['Shipped by Seller', 'TikTokOrderID:576967097623484645', 'NORMAL']))
      .toBe('576967097623484645');
    // Shopify sends tags as one comma string on some payloads.
    expect(tiktokOrderIdFromTags('Shipped by Seller, TikTokOrderID:576967097623484645, NORMAL'))
      .toBe('576967097623484645');
    expect(tiktokOrderIdFromTags(['NORMAL'])).toBeNull();
    expect(tiktokOrderIdFromTags(null)).toBeNull();
    // A tag with no digits is not an order id, and nothing may be guessed.
    expect(tiktokOrderIdFromTags(['TikTokOrderID:'])).toBeNull();
    expect(tiktokOrderIdFromTags(['TikTokOrderID:not-a-number'])).toBeNull();

    // But the tag is still there, and that is what the ingest refuses on.
    expect(hasTikTokTag(['TikTokOrderID:'])).toBe(true);
    expect(hasTikTokTag(['TikTokOrderID:not-a-number'])).toBe(true);
    expect(hasTikTokTag(['NORMAL'])).toBe(false);
    expect(hasTikTokTag(null)).toBe(false);
  });

  it('knows the two app ids, for the orders that carry no source_name', () => {
    expect(SOURCE_BY_APP_ID['580111']).toBe('web');
    expect(SOURCE_BY_APP_ID['1354745']).toBe('shopify_draft_order');
    // And not the TikTok channel's, which is 4383523.
    expect(SOURCE_BY_APP_ID['4383523']).toBeUndefined();
  });

  it('refuses a TikTok order on the tag alone, whatever the channel says', () => {
    const verdict = verdictFor(STORE, { source_name: 'web', tags: ['TikTokOrderID:576967097623484645'] });
    expect(verdict.accept).toBe(false);
    expect(verdict.accept === false && verdict.reason).toBe('tiktok');
  });
});

/* ============================================================== the ingest */

describe('an order arriving from', () => {
  it('the Online Store is taken', async () => {
    const result = await ingestShopifyOrder(STORE, order({ source: 'web' }));
    expect(result.status).toBe('created');
    expect((await counts()).shipments).toBe(1);
  });

  it('Draft Orders is taken', async () => {
    const result = await ingestShopifyOrder(STORE, order({ n: 2, source: 'shopify_draft_order' }));
    expect(result.status).toBe('created');
    expect((await counts()).shipments).toBe(1);
  });

  it('the TikTok channel is refused, and WRITES NOTHING', async () => {
    const result = await ingestShopifyOrder(STORE, tiktokOrder());

    expect(result.status).toBe('other_channel');
    expect(result.shipmentIds).toEqual([]);
    expect(result.channel?.accept).toBe(false);
    expect(result.channel?.accept === false && result.channel.reason).toBe('tiktok');

    // The whole point. Not "created and hidden": absent.
    expect(await counts()).toEqual({ orders: 0, shipments: 0, activity: 0 });
  });

  it('an app with no named channel is refused by default', async () => {
    // Shopify puts the bare app id in `source_name` for those. Two have turned
    // up on this store, once each, and neither is known to be a real channel.
    const result = await ingestShopifyOrder(STORE, order({ n: 3, source: '2329312' }));
    expect(result.status).toBe('other_channel');
    expect(result.channel?.accept === false && result.channel.reason).toBe('other_channel');
    expect(await counts()).toEqual({ orders: 0, shipments: 0, activity: 0 });
  });

  it('that same app once the operator allows it', async () => {
    process.env[SOURCES_VAR] = 'web,shopify_draft_order,2329312';
    const result = await ingestShopifyOrder(STORE, order({ n: 3, source: '2329312' }));
    expect(result.status).toBe('created');
    expect((await counts()).shipments).toBe(1);
  });

  it('the Online Store but carrying a TikTok tag is refused', async () => {
    // The tag wins. Either the channel is mislabelling itself or somebody has
    // a workaround; either way the TikTok file is the better source.
    const result = await ingestShopifyOrder(STORE, {
      ...order({ n: 4, source: 'web' }),
      tags: ['TikTokOrderID:576967097623484999'],
    });
    expect(result.status).toBe('other_channel');
    expect(await counts()).toEqual({ orders: 0, shipments: 0, activity: 0 });
  });

  it('the Online Store with a TikTok tag we cannot read is STILL refused', async () => {
    /*
     * On presence, not on readability. The tag means the TikTok channel wrote
     * it, and taking the order anyway is the failure nobody can see — the
     * parcel under the wrong shop. Refusing it is the visible failure: the
     * pull counts it and says so. The handover has the opposite problem, and
     * leaves an unreadable tag alone rather than guessing an id.
     */
    const result = await ingestShopifyOrder(STORE, {
      ...order({ n: 10, source: 'web' }),
      tags: ['Shipped by Seller', 'TikTokOrderID:', 'NORMAL'],
    });
    expect(result.status).toBe('other_channel');
    expect(result.channel?.accept === false && result.channel.reason).toBe('tiktok');
    expect(result.channel?.accept === false && result.channel.reason === 'tiktok'
      && result.channel.tiktokOrderId).toBeNull();
    expect(await counts()).toEqual({ orders: 0, shipments: 0, activity: 0 });
  });

  it('no channel at all, but the Online Store app id, is taken', async () => {
    const result = await ingestShopifyOrder(STORE, order({ n: 5, source: null, appId: 580111 }));
    expect(result.status).toBe('created');
    expect((await counts()).shipments).toBe(1);
  });

  it('no channel and no app id is refused', async () => {
    // Nothing to check it against. Taking it would be the old behaviour.
    const result = await ingestShopifyOrder(STORE, order({ n: 6, source: null }));
    expect(result.status).toBe('other_channel');
    expect(await counts()).toEqual({ orders: 0, shipments: 0, activity: 0 });
  });

  it('a store that does not exist still throws, as it did', async () => {
    // The channel check runs first, so this only still happens for an order
    // that WOULD have been taken — which is the case worth knowing about.
    await expect(ingestShopifyOrder('nosuchstore', order({ n: 7 })))
      .rejects.toThrow(/no store configured/);
  });
});

/* ============================================================= the webhook */

describe('the webhook', () => {
  function post(payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');
    const req = new Request(`http://localhost/api/webhooks/shopify/${STORE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': signature },
      body,
    });
    return webhook(req, { params: { store: STORE } });
  }

  it('answers 200 to a TikTok order and changes nothing', async () => {
    /*
     * 200, not 4xx. Shopify retries a failed delivery for days and turns a
     * webhook off after enough of them, and there is nothing wrong with the
     * delivery — we simply do not want the order. A 422 here would eventually
     * cost us the webhook that brings the Online Store orders in.
     */
    const before = await counts();
    const res = await post(tiktokOrder(8));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'other_channel', shipments: 0 });
    expect(await counts()).toEqual(before);
  });

  it('still takes an Online Store order', async () => {
    const res = await post(order({ n: 9, source: 'web' }));
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('created');
    expect((await counts()).shipments).toBe(1);
  });
});

/* ================================================================ the pull */

describe('the thirty-day pull', () => {
  function shopify(payloads: unknown[]) {
    const fetchImpl = (async () => new Response(JSON.stringify({ orders: payloads }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    return fetchImpl;
  }

  it('takes the Online Store and Draft Orders, and reports the rest', async () => {
    const report = await pullStore(STORE, {
      fetchImpl: shopify([
        order({ n: 11, source: 'web' }),
        order({ n: 12, source: 'shopify_draft_order' }),
        tiktokOrder(13),
        tiktokOrder(14),
        order({ n: 15, source: '2329312' }),
      ]),
    });

    expect(report.checked).toBe(5);
    expect(report.added).toBe(2);
    expect(report.tiktokOrders).toBe(2);
    expect(report.otherChannel).toBe(1);
    // Two parcels, from the two orders that were ours to take.
    expect((await counts()).shipments).toBe(2);
  });

  it('counts a TikTok order as TikTok even in its REAL fulfilment shape', async () => {
    /*
     * The shape that mattered and nearly got missed. A TikTok Shop fulfilment
     * carries a PKA6TP… code with no carrier name, which `isCorreos`
     * deliberately does not recognise — so when the pull asked about the
     * fulfilment before it asked about the channel, most of the 235 landed in
     * `notCorreos` and the line the operator reads understated the skip by
     * most of its number.
     */
    const report = await pullStore(STORE, {
      fetchImpl: shopify([{
        ...tiktokOrder(17),
        fulfillments: [{
          id: 9917,
          tracking_company: '',
          tracking_number: 'PKA6TP9800094740148903F',
          created_at: '2026-10-14T11:00:00Z',
        }],
      }]),
    });

    expect(report.tiktokOrders).toBe(1);
    expect(report.notCorreos).toBe(0);
    expect(report.added).toBe(0);
  });

  it('counts a TikTok order as TikTok, not as "not Correos"', async () => {
    // It has a perfectly good Correos fulfilment. Lumping it in with the
    // genuinely uninteresting orders would hide 235 of 250 behind a label
    // that says nothing about what to do.
    const report = await pullStore(STORE, { fetchImpl: shopify([tiktokOrder(16)]) });
    expect(report.tiktokOrders).toBe(1);
    expect(report.notCorreos).toBe(0);
    expect(report.added).toBe(0);
  });
});
