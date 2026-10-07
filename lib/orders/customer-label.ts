/**
 * What to call a customer we have no name for.
 *
 * The marketplace tracking files carry no customer details at all — no name,
 * phone, email or address. The importer used to write "Unknown customer" into
 * `orders.customer_name`, which then leaked into the Spanish message as
 * "Hola Unknown, somos TikTok Shop ES", because `firstName` takes the first
 * word of whatever is there.
 *
 * So the database stores the empty string: it genuinely does not know. The
 * label belongs to the screens, and it lives here so every screen agrees.
 *
 * The useful side effect is that the customer text needs no special case.
 * `firstName('')` is `''`, and `officeDetails` now handles a missing name — so
 * the greeting becomes "Hola," by itself rather than by a check somebody has
 * to remember to write.
 */

export interface LabelFor {
  customerName: string | null;
  orderNumber: string;
  /** `stores.platform`. Decides which marketplace is named. */
  platform?: string | null;
}

/** "Amazon order 404-…" — enough to recognise, short enough for a column. */
function shortId(orderNumber: string, platform: string | null | undefined): string {
  const id = orderNumber.trim();
  if (!id) return '';
  // Amazon's ids are three dashed groups; the first is enough to tell them
  // apart at a glance, and the full one is in the order-number column anyway.
  if (platform === 'amazon' && id.includes('-')) return `${id.split('-')[0]}-…`;
  if (id.length > 8) return `${id.slice(0, 4)}…`;
  return id;
}

export function customerLabel(o: LabelFor): string {
  const name = (o.customerName ?? '').trim();
  if (name) return name;

  const short = shortId(o.orderNumber, o.platform);
  if (o.platform === 'tiktok') return short ? `TikTok order ${short}` : 'TikTok order';
  if (o.platform === 'amazon') return short ? `Amazon order ${short}` : 'Amazon order';
  return 'Unknown customer';
}

/**
 * The name to put in a message TO the customer, or '' when there is none.
 *
 * Deliberately not `customerLabel`: "Hola TikTok order 5769…," is worse than
 * no greeting at all, and the label is for our screens, not for them.
 */
export function realFirstName(customerName: string | null): string {
  const name = (customerName ?? '').trim();
  if (!name) return '';
  return name.split(/\s+/)[0] ?? '';
}

/** True when the order came in through a marketplace's own fulfilment file. */
export function isMarketplace(platform: string | null | undefined): boolean {
  return platform === 'tiktok' || platform === 'amazon';
}
