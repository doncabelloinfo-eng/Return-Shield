import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { shopifyHandle, shopifyOrderLink } from '@/lib/orders/shopify-link';
import { marketplaceOrderLink } from '@/lib/orders/marketplace-link';
import { loadRows } from '@/lib/views/rows';
import { parcelsView } from '@/lib/views/parcels';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * "Open in Shopify".
 *
 * The one thing worth guarding here is that the link is built from Shopify's
 * NUMERIC order id and never from the order name. `/orders/%2322197` is a 404,
 * and a dead link offered at the moment somebody is trying to stop a parcel
 * going back is worse than no link at all.
 */

const REAL_ID = '8437775565146';

beforeEach(resetDb);
afterAll(closeDb);

describe('the handle', () => {
  it('is the shop domain without .myshopify.com', () => {
    expect(shopifyHandle('doncabellopro.myshopify.com')).toBe('doncabellopro');
  });

  it('survives a pasted-in URL', () => {
    expect(shopifyHandle('https://doncabellopro.myshopify.com/')).toBe('doncabellopro');
  });

  it('is null when there is no domain', () => {
    expect(shopifyHandle(null)).toBeNull();
    expect(shopifyHandle('')).toBeNull();
    expect(shopifyHandle('   ')).toBeNull();
  });

  it('refuses a domain that is not a myshopify host', () => {
    // A custom storefront domain is not the admin handle, and guessing that it
    // is produces a plausible-looking 404.
    expect(shopifyHandle('shop.doncabello.com')).toBeNull();
  });
});

describe('the link', () => {
  it('is built from the handle and the numeric id', () => {
    expect(shopifyOrderLink('shopify', 'doncabellopro.myshopify.com', REAL_ID))
      .toBe(`https://admin.shopify.com/store/doncabellopro/orders/${REAL_ID}`);
  });

  it('is absent when the store has no shop domain', () => {
    expect(shopifyOrderLink('shopify', null, REAL_ID)).toBeNull();
  });

  it('is never built from the order name', () => {
    expect(shopifyOrderLink('shopify', 'doncabellopro.myshopify.com', '#22197')).toBeNull();
    expect(shopifyOrderLink('shopify', 'doncabellopro.myshopify.com', '22197-A')).toBeNull();
    expect(shopifyOrderLink('shopify', 'doncabellopro.myshopify.com', 'ext-PQ123ES')).toBeNull();
  });

  it('is only for Shopify parcels', () => {
    expect(shopifyOrderLink('tiktok', 'doncabellopro.myshopify.com', REAL_ID)).toBeNull();
    expect(shopifyOrderLink('amazon', 'doncabellopro.myshopify.com', REAL_ID)).toBeNull();
    expect(shopifyOrderLink(null, 'doncabellopro.myshopify.com', REAL_ID)).toBeNull();
  });
});

describe('on the screens', () => {
  it('reaches both the parcel page and the Parcels rows', async () => {
    const f = await makeShipment({
      shippingCode: 'PQ70000001ES',
      state: 'at_office',
      shopDomain: 'doncabellopro.myshopify.com',
      externalOrderId: REAL_ID,
    });

    const [row] = (await loadRows()).filter((r) => r.id === f.shipmentId);
    expect(row.shopifyHref).toBe(`https://admin.shopify.com/store/doncabellopro/orders/${REAL_ID}`);

    const view = await parcelsView({ status: 'at_office' });
    expect(view.rows.find((r) => r.id === f.shipmentId)?.shopifyHref)
      .toBe(`https://admin.shopify.com/store/doncabellopro/orders/${REAL_ID}`);
  });

  it('shows no link for a shop with no domain', async () => {
    const f = await makeShipment({ shippingCode: 'PQ70000002ES', externalOrderId: REAL_ID });

    const [row] = (await loadRows()).filter((r) => r.id === f.shipmentId);
    expect(row.shopifyHref).toBe('');
  });

  it('leaves the marketplace rows their own links', () => {
    process.env.TIKTOK_ORDER_URL = 'https://seller-es.tiktok.com/order/detail?order_no={id}&shop_region=ES';
    process.env.AMAZON_ORDER_URL = 'https://sellercentral.amazon.es/orders-v3/order/{id}';
    try {
      expect(marketplaceOrderLink('tiktok', '577000000000000001'))
        .toBe('https://seller-es.tiktok.com/order/detail?order_no=577000000000000001&shop_region=ES');
      expect(marketplaceOrderLink('amazon', '404-1234567-1234567'))
        .toBe('https://sellercentral.amazon.es/orders-v3/order/404-1234567-1234567');
      // And the Shopify builder keeps its hands off them.
      expect(shopifyOrderLink('tiktok', 'doncabellopro.myshopify.com', '577000000000000001')).toBeNull();
    } finally {
      delete process.env.TIKTOK_ORDER_URL;
      delete process.env.AMAZON_ORDER_URL;
    }
  });
});
