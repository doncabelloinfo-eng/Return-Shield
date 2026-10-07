/**
 * "Open in Shopify" — the order, in the admin, in one click.
 *
 * The Amazon and TikTok rows already have this, and they need a configured
 * URL template because their seller-central paths are not guessable. Shopify's
 * is: the admin lives at one address for every shop, and everything the link
 * needs is already stored.
 *
 *   https://admin.shopify.com/store/{handle}/orders/{id}
 *
 * `{handle}` is the shop domain with `.myshopify.com` taken off —
 * `doncabellopro.myshopify.com` is the shop `doncabellopro`. So no environment
 * variable, and nothing to keep in step with the stores table.
 *
 * `{id}` is Shopify's NUMERIC order id, which is what `orders.external_order_id`
 * holds (`String(payload.id)` in lib/carriers/shopify/ingest.ts). It is
 * emphatically not the order name: `/orders/%2322197` is a 404, and a dead
 * link offered at the moment somebody is trying to save a parcel is worse than
 * no link. Hence the digits-only check below — a row whose external id is a
 * name rather than an id gets no link rather than a broken one.
 */

/** The shop handle, or null when the store has no `shop_domain`. */
export function shopifyHandle(shopDomain: string | null | undefined): string | null {
  const domain = (shopDomain ?? '').trim().toLowerCase();
  if (!domain) return null;

  // The stored value is the host Shopify sends on its webhooks, so it is
  // normally bare — but a pasted-in `https://…/` is the obvious way for it to
  // arrive wrong, and the handle is the first path-free label either way.
  const host = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const handle = host.replace(/\.myshopify\.com$/, '');
  if (!handle || handle.includes('.') || !/^[a-z0-9-]+$/.test(handle)) return null;

  return handle;
}

/**
 * The admin link for one order, or null when we cannot build a real one.
 *
 * Null, never a guess: no shop domain, or an external id that is not a numeric
 * Shopify order id, and the screen simply shows no link.
 */
export function shopifyOrderLink(
  platform: string | null | undefined,
  shopDomain: string | null | undefined,
  externalOrderId: string | null | undefined,
): string | null {
  if (platform !== 'shopify') return null;

  const handle = shopifyHandle(shopDomain);
  if (!handle) return null;

  const id = (externalOrderId ?? '').trim();
  if (!/^\d+$/.test(id)) return null;

  return `https://admin.shopify.com/store/${handle}/orders/${id}`;
}
