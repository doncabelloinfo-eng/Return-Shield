import { env } from '@/lib/env';

/**
 * A link that opens an order in the marketplace that sent it.
 *
 * The parcels from the Amazon and TikTok tracking files have no phone and no
 * email, so the only way to reach those customers is the marketplace's own
 * message thread. That needs a URL, and these URLs are not guessable: the
 * seller-central paths differ per marketplace, per region and per account, and
 * a wrong one sends the operator to a 404 at the moment they are trying to
 * stop a parcel going back.
 *
 * So there is NO DEFAULT. Both variables are optional and empty until the
 * operator pastes in a real one, and until then the screen offers "Copy order
 * number" instead — which still works, it just takes one more paste.
 *
 *   AMAZON_ORDER_URL=https://sellercentral.amazon.es/orders-v3/order/{id}
 *   TIKTOK_ORDER_URL=https://seller-es.tiktok.com/order/detail?order_no={id}
 *
 * `{id}` is replaced with the order number, URL-encoded.
 */

const TEMPLATE_VAR: Record<string, string> = {
  amazon: 'AMAZON_ORDER_URL',
  tiktok: 'TIKTOK_ORDER_URL',
};

/** The link, or null when the template for that marketplace is not set. */
export function marketplaceOrderLink(
  platform: string | null | undefined,
  orderNumber: string,
): string | null {
  if (!platform) return null;
  const variable = TEMPLATE_VAR[platform];
  if (!variable) return null;

  const template = env(variable);
  if (!template || !template.includes('{id}')) return null;

  const id = orderNumber.trim();
  if (!id) return null;

  return template.replace('{id}', encodeURIComponent(id));
}

/** "Amazon" / "TikTok Shop", for the link's label. */
export function marketplaceName(platform: string | null | undefined): string {
  if (platform === 'amazon') return 'Amazon';
  if (platform === 'tiktok') return 'TikTok Shop';
  return 'the marketplace';
}
