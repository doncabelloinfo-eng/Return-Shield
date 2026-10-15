import { envList } from '@/lib/env';
import { storeEnvName } from './verify';
import type { ShopifyOrderPayload } from './ingest';

/**
 * Which Shopify channels Return Shield takes orders from.
 *
 * THE PROBLEM THIS SOLVES. `doncabellopro` has the TikTok sales channel
 * installed, so every TikTok Shop order is also a Shopify order — 235 of the
 * store's last 250, against 12 from the Online Store and 3 Draft Orders. The
 * webhook, the hourly backfill and the thirty-day pull all took them, so a
 * TikTok parcel reached the system twice: once from Shopify and once from the
 * TikTok upload. Shipments are unique by tracking code, so whichever arrived
 * first owned the parcel — and the webhook fires at fulfilment, so it was
 * usually Shopify. The parcel then sat under "Don Cabello Profesional" with a
 * #22xxx Shopify name, and never appeared under "TikTok Shop ES", which is the
 * filter the TikTok Shop team works from. 92 consecutive order numbers of one
 * store's 213 parcels were in that state.
 *
 * So: from Shopify we take the Online Store and Draft Orders. TikTok orders
 * come from the TikTok upload, which is where their own order ids and their
 * own shop name are.
 *
 * ONE CHECK, AT THE TOP OF `ingestShopifyOrder`, which is what the webhook,
 * the backfill and the pull all go through. Three checks in three places is
 * how one of them gets forgotten.
 */

/** The two channels the operator wants, by Shopify's own `source_name`. */
export const DEFAULT_ORDER_SOURCES = ['web', 'shopify_draft_order'] as const;

/**
 * Shopify's app ids for those two, for the orders that carry no `source_name`.
 *
 * Observed on this store: 580111 is the Online Store and 1354745 is Draft
 * Orders. (4383523 is the TikTok channel, which is not here on purpose.)
 */
export const SOURCE_BY_APP_ID: Record<string, string> = {
  580111: 'web',
  1354745: 'shopify_draft_order',
};

/**
 * The tag every TikTok-channel order carries, next to `Shipped by Seller` and
 * `NORMAL`: `TikTokOrderID:576967097623484645`.
 *
 * It is the second guard, and it is the one that does not depend on Shopify
 * keeping its channel names stable. It is also what makes the orders already
 * pulled findable — see lib/orders/tiktok-handover.ts.
 */
export const TIKTOK_TAG_PREFIX = 'TikTokOrderID:';

/**
 * The allowlist for one store, lowercased.
 *
 * Per store, because a second Shopify shop may well sell through channels this
 * one does not. Unset means the two defaults; the operator can add a
 * `source_name` or a bare app id later if one of the rare ones turns out to be
 * a real channel.
 */
export function allowedSources(storeKey: string): string[] {
  const configured = envList(storeEnvName(storeKey, 'ORDER_SOURCES'));
  const list = configured.length ? configured : [...DEFAULT_ORDER_SOURCES];
  return list.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function normaliseTagList(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : tags.split(',');
  return list.map((t) => String(t).trim()).filter(Boolean);
}

/**
 * Whether the TikTok channel tagged this order at all.
 *
 * SEPARATE FROM READING THE ID, and the difference decides a real case. The
 * rule is "an order carrying a TikTokOrderID tag is not ours to take", so this
 * answers on the tag's PRESENCE: a tag with nothing readable after the colon
 * still means the TikTok channel wrote it, and taking the order would put the
 * parcel under the wrong shop again — which is the failure nobody can see.
 * Refusing it is visible: the pull counts and reports it.
 *
 * The handover (lib/orders/tiktok-handover.ts) needs the id itself, and cannot
 * invent one, so it uses the function below and leaves an unreadable tag alone.
 */
export function hasTikTokTag(tags: string | string[] | null | undefined): boolean {
  const prefix = TIKTOK_TAG_PREFIX.toLowerCase();
  return normaliseTagList(tags).some((t) => t.toLowerCase().startsWith(prefix));
}

/** The 18-digit TikTok order id out of the tags, or null. */
export function tiktokOrderIdFromTags(tags: string | string[] | null | undefined): string | null {
  for (const tag of normaliseTagList(tags)) {
    if (!tag.toLowerCase().startsWith(TIKTOK_TAG_PREFIX.toLowerCase())) continue;
    const id = tag.slice(TIKTOK_TAG_PREFIX.length).trim();
    if (/^\d+$/.test(id)) return id;
  }
  return null;
}

export type ChannelVerdict =
  | { accept: true; source: string }
  /** A TikTok Shop order. It comes from the upload, not from here. */
  | { accept: false; reason: 'tiktok'; source: string | null; tiktokOrderId: string | null }
  /** Some other channel or app. Add it to the allowlist if it is real. */
  | { accept: false; reason: 'other_channel'; source: string | null };

/**
 * Where an order came from: `source_name` if Shopify sent one, otherwise what
 * `app_id` says.
 *
 * Shopify puts the bare app id in `source_name` for an app with no named
 * channel — `2329312` and `3890849` both turned up that way on this store —
 * so the raw id is kept as a second candidate, which is what lets an operator
 * allow one by pasting the number into the environment variable.
 */
export function channelOf(payload: ShopifyOrderPayload): {
  source: string | null;
  appId: string | null;
} {
  const source = String(payload.source_name ?? '').trim().toLowerCase() || null;
  const appId = payload.app_id === null || payload.app_id === undefined
    ? null
    : String(payload.app_id).trim() || null;

  return { source: source ?? (appId ? SOURCE_BY_APP_ID[appId] ?? null : null), appId };
}

export function verdictFor(storeKey: string, payload: ShopifyOrderPayload): ChannelVerdict {
  const tagged = hasTikTokTag(payload.tags);
  const tiktokId = tiktokOrderIdFromTags(payload.tags);
  const { source, appId } = channelOf(payload);

  /*
   * The tag wins over everything, including an allowlisted `source_name`.
   *
   * An order tagged `TikTokOrderID:` is a TikTok Shop order whatever else it
   * says about itself: the upload owns it, and taking it here is what put 77
   * of them under the wrong shop. A `web` order with that tag is either the
   * channel mislabelling itself or somebody's workaround, and in both cases
   * the TikTok file is the better source.
   */
  if (tagged || source === 'tiktok') {
    return { accept: false, reason: 'tiktok', source, tiktokOrderId: tiktokId };
  }

  const allowed = allowedSources(storeKey);
  const candidates = [source, appId].filter((c): c is string => Boolean(c));

  if (candidates.some((c) => allowed.includes(c.toLowerCase()))) {
    return { accept: true, source: source ?? candidates[0] };
  }

  return { accept: false, reason: 'other_channel', source };
}
