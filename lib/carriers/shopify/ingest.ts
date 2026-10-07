import { and, eq, sql as raw } from 'drizzle-orm';
import { getDb } from '@/db';
import { orders, shipments, stores } from '@/db/schema';
import { normalisePhone } from '@/lib/import/phone';
import { parseMoneyCents } from '@/lib/import/parse';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';

/**
 * Turning a Shopify `orders/fulfilled` payload into an order and a shipment.
 *
 * Shared by the webhook and the hourly backfill, so a fulfilment that arrives
 * twice — once by webhook and once because the webhook never arrived and the
 * backfill found it — produces exactly one shipment.
 */

/** Correos under the several names Shopify stores enter it as. */
const CORREOS_NAMES = /correos|chronoexpr[eé]s|paq\s?(48|72|est[aá]ndar|premium|ligero)/i;

export interface ShopifyFulfilment {
  id?: number | string;
  tracking_company?: string | null;
  tracking_number?: string | null;
  tracking_numbers?: string[] | null;
  tracking_url?: string | null;
  created_at?: string | null;
  line_items?: { sku?: string | null; title?: string | null }[];
}

export interface ShopifyOrderPayload {
  id?: number | string;
  name?: string | null;
  order_number?: number | string | null;
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  total_price?: string | number | null;
  currency?: string | null;
  financial_status?: string | null;
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  tags?: string | string[] | null;
  customer?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null;
  shipping_address?: {
    name?: string | null; first_name?: string | null; last_name?: string | null;
    address1?: string | null; address2?: string | null;
    city?: string | null; zip?: string | null; province?: string | null;
    country_code?: string | null; phone?: string | null;
  } | null;
  fulfillments?: ShopifyFulfilment[] | null;
}

export interface IngestOrderResult {
  status: 'created' | 'existing' | 'not_correos' | 'no_tracking';
  shipmentIds: string[];
}

export function isCorreos(f: ShopifyFulfilment): boolean {
  const company = f.tracking_company ?? '';
  if (CORREOS_NAMES.test(company)) return true;
  // Some stores leave the company blank but the URL gives it away.
  if (f.tracking_url && /correos\.es/i.test(f.tracking_url)) return true;
  // Correos domestic codes: a letter pair, digits, then ES.
  const code = f.tracking_number ?? f.tracking_numbers?.[0] ?? '';
  return /^[A-Z]{2}\d{9,}ES$/i.test(code.trim());
}

export interface IngestOrderOptions {
  /**
   * Narrate nothing. Used by the thirty-day pull.
   *
   * One line per order is right for a webhook — one order arrives, one line
   * says so — and wrong for a thousand at once: the ticker holds twenty-four
   * hours, so a pull would bury a whole day of real events under history. The
   * pull says "Pulled N parcels from the last 30 days of {store}" once
   * instead.
   */
  quiet?: boolean;
}

export async function ingestShopifyOrder(
  storeKey: string,
  payload: ShopifyOrderPayload,
  opts: IngestOrderOptions = {},
): Promise<IngestOrderResult> {
  const [store] = await getDb().select().from(stores).where(eq(stores.key, storeKey)).limit(1);
  if (!store) throw new Error(`shopify: no store configured with key "${storeKey}"`);

  const fulfilments = (payload.fulfillments ?? []).filter(isCorreos);
  if (!fulfilments.length) return { status: 'not_correos', shipmentIds: [] };

  const codes = fulfilments
    .flatMap((f) => [f.tracking_number, ...(f.tracking_numbers ?? [])])
    .filter((c): c is string => Boolean(c && c.trim()))
    .map((c) => c.trim().toUpperCase());

  const unique = [...new Set(codes)];
  if (!unique.length) return { status: 'no_tracking', shipmentIds: [] };

  const externalOrderId = String(payload.id ?? payload.name ?? unique[0]);
  const addr = payload.shipping_address ?? {};
  const rawPhone = addr.phone ?? payload.phone ?? payload.customer?.phone ?? null;
  const phone = normalisePhone(rawPhone);

  const customerName = [addr.name, joinName(addr.first_name, addr.last_name),
    joinName(payload.customer?.first_name, payload.customer?.last_name)]
    .find((n) => n && n.trim()) ?? 'Unknown customer';

  const [order] = await getDb().insert(orders).values({
    storeId: store.id,
    externalOrderId,
    orderNumber: String(payload.name ?? payload.order_number ?? externalOrderId),
    customerName,
    phoneE164: phone.e164,
    phoneRaw: rawPhone,
    phoneStatus: phone.status,
    email: payload.email ?? null,
    addressLine: [addr.address1, addr.address2].filter(Boolean).join(', ') || null,
    city: addr.city ?? null,
    postalCode: addr.zip ?? null,
    province: addr.province ?? null,
    country: addr.country_code ?? 'ES',
    totalValueCents: parseMoneyCents(String(payload.total_price ?? '0')),
    currency: payload.currency ?? 'EUR',
    paymentMethod: paymentMethodOf(payload),
    placedAt: payload.created_at ? new Date(payload.created_at) : now(),
    tags: normaliseTags(payload.tags),
    createdAt: now(),
  }).onConflictDoUpdate({
    target: [orders.storeId, orders.externalOrderId],
    // A re-delivered webhook may carry a corrected address or phone.
    set: {
      customerName,
      phoneE164: phone.e164,
      phoneRaw: rawPhone,
      phoneStatus: phone.status,
      addressLine: [addr.address1, addr.address2].filter(Boolean).join(', ') || null,
      city: addr.city ?? null,
      postalCode: addr.zip ?? null,
    },
  }).returning({ id: orders.id });

  const created: string[] = [];
  const existing: string[] = [];

  for (const code of unique) {
    const productCode = productCodeOf(fulfilments, code);
    const shippedAt = fulfilledAt(fulfilments, code);

    /*
     * An upsert rather than `onConflictDoNothing`, so the thirty-day pull can
     * give an existing parcel its real ship date. The migration backfilled
     * every pre-existing row with `created_at`, and the fulfilment's own
     * `created_at` is the truth — the pull is how those get corrected.
     *
     * Nothing else about an existing shipment is touched. `state`,
     * `state_since` and the deadlines belong to the projection, and writing
     * them here would be a second source for a column with one owner.
     *
     * `xmax = 0` is Postgres' own answer to "was that an insert or an
     * update", and the distinction matters: a parcel the pull merely re-dated
     * is not a new parcel, and announcing it would put a thousand lines in the
     * ticker about history.
     */
    const [row] = await getDb().insert(shipments).values({
      orderId: order.id,
      carrier: 'correos',
      shippingCode: code,
      productCode,
      state: 'created',
      shippedAt,
      createdAt: now(),
    }).onConflictDoUpdate({
      target: shipments.shippingCode,
      set: { shippedAt: shippedAt ?? raw`${shipments.shippedAt}` },
    }).returning({ id: shipments.id, fresh: raw<boolean>`(xmax = 0)` });

    if (!row) continue;
    if (row.fresh) created.push(row.id); else existing.push(row.id);
  }

  if (created.length) {
    if (!opts.quiet) {
      // `created[0]` so the ticker line can link to the parcel. The line was
      // being written without one, so the one place it would have been useful
      // — "which parcel is this about" — went nowhere.
      await say(
        `${customerName} — ${payload.name ?? externalOrderId} picked up from ${store.name}`,
        created[0],
      );
    }
    return { status: 'created', shipmentIds: created };
  }

  return { status: 'existing', shipmentIds: existing };
}

function joinName(a?: string | null, b?: string | null): string {
  return [a, b].filter(Boolean).join(' ').trim();
}

/**
 * Cash on delivery matters more than anything else on the order: it is the
 * difference between losing the margin and losing the whole sale. Spanish
 * stores name the gateway half a dozen ways, so we check all of them.
 */
function paymentMethodOf(p: ShopifyOrderPayload): 'prepaid' | 'cod' {
  const names = [
    p.gateway ?? '',
    ...(p.payment_gateway_names ?? []),
  ].join(' ').toLowerCase();

  if (/cash on delivery|contra ?reembolso|contrareembolso|reembolso|cod\b/.test(names)) return 'cod';
  // Nothing collected yet and no prepaid gateway named: treat as COD, because
  // under-reacting to a cash-on-delivery parcel is the expensive mistake.
  if (p.financial_status === 'pending' && !names.trim()) return 'cod';
  return 'prepaid';
}

function normaliseTags(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  return tags.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * When Correos was handed this parcel: the fulfilment's own `created_at`.
 *
 * Not the order's. An order placed on the 1st and posted on the 6th is five
 * days of retention window apart, and the ship date is the one the window
 * counts from.
 */
export function fulfilledAt(fulfilments: ShopifyFulfilment[], code: string): Date | null {
  const f = fulfilments.find((x) =>
    x.tracking_number?.trim().toUpperCase() === code
    || x.tracking_numbers?.some((c) => c.trim().toUpperCase() === code));

  if (!f?.created_at) return null;
  const at = new Date(f.created_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The Correos service, which decides how long the office holds it. */
function productCodeOf(fulfilments: ShopifyFulfilment[], code: string): string {
  const f = fulfilments.find((x) =>
    x.tracking_number?.toUpperCase() === code || x.tracking_numbers?.some((c) => c.toUpperCase() === code));
  const company = f?.tracking_company ?? '';
  const m = /paq\s?(48|72|est[aá]ndar|premium|ligero)/i.exec(company);
  if (m) return `PAQ ${m[1].toUpperCase()}`;
  return 'PAQ ESTÁNDAR';
}

export async function shipmentExists(shippingCode: string): Promise<boolean> {
  const [row] = await getDb().select({ id: shipments.id }).from(shipments)
    .where(eq(shipments.shippingCode, shippingCode.trim().toUpperCase())).limit(1);
  return Boolean(row);
}
