import { and, eq, sql as raw } from 'drizzle-orm';
import { getDb, rowsOf } from '@/db';
import { orders, shipments, stores } from '@/db/schema';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';
import { SOURCE_STORE } from '@/lib/import/parse';
import { TIKTOK_TAG_PREFIX, tiktokOrderIdFromTags } from '@/lib/carriers/shopify/channel';

/**
 * Giving back the TikTok orders Shopify already handed us.
 *
 * WHAT WENT WRONG. The TikTok sales channel is installed on the Shopify store,
 * so every TikTok Shop order is also a Shopify order, and the webhook took it
 * at fulfilment — usually before the TikTok upload saw it. Shipments are
 * unique by tracking code, so Shopify owned the parcel: it sat under "Don
 * Cabello Profesional" with a #22xxx Shopify order number, the TikTok upload
 * then skipped it as a duplicate, and it never appeared under "TikTok Shop
 * ES", which is the filter the TikTok Shop team works from. 92 consecutive
 * order numbers of that store's 213 parcels were in that state.
 *
 * lib/carriers/shopify/channel.ts stops it happening again. This moves the
 * ones already in.
 *
 * WHY IT IS AN ACTION AND NOT A MIGRATION. It needs a dry run before anybody
 * commits to it, it has to be safe to press twice, and the person pressing it
 * is the operator's assistant in a browser, not somebody with psql open.
 *
 * WHAT IT MOVES, AND WHAT IT KEEPS. The shipment ROW is re-pointed, never
 * recreated: its id, state, events, contact log, tasks and closures all hang
 * off that id, so recreating it would lose every bit of tracking history the
 * parcel has. The Shopify order row then goes, once nothing points at it —
 * and the guard matters, because `shipments.order_id` cascades on delete, so
 * deleting the order first would take the parcel with it.
 */

/** A Shopify order that carries a TikTok order id. */
export interface TaggedOrder {
  orderId: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  /** Null when the tag is there but carries no digits. Those are left alone. */
  tiktokOrderId: string | null;
  parcels: number;
  valueCents: number;
  currency: string;
  paymentMethod: 'prepaid' | 'cod';
}

export interface HandoverPreview {
  /** Shopify orders carrying a TikTokOrderID tag. */
  tiktokOrders: number;
  /** Parcels that would move to TikTok Shop ES. */
  parcelsToMove: number;
  /** Of those orders, the ones that have no parcel — the upload got there first. */
  emptyRows: number;
  /** Tags we could not read an id out of. Left exactly as they are. */
  unreadableTags: number;
  /** Which Shopify shops they are in, for the line on screen. */
  byStore: { store: string; orders: number; parcels: number }[];
}

export interface HandoverResult extends HandoverPreview {
  moved: number;
  ordersRemoved: number;
  tiktokOrdersCreated: number;
}

interface RawTaggedOrder {
  order_id: string;
  order_number: string;
  store_id: string;
  store_name: string;
  tags: string[] | null;
  parcels: number | string;
  total_value_cents: number | string;
  currency: string | null;
  payment_method: 'prepaid' | 'cod' | null;
}

/**
 * The one query both halves use.
 *
 * Shared on purpose: the preview promises the operator a number and the apply
 * has to produce that number. Two queries that agree today are two queries
 * that disagree the first time somebody edits one.
 */
export async function taggedShopifyOrders(): Promise<TaggedOrder[]> {
  const result = await getDb().execute(raw`
    SELECT o.id AS order_id,
           o.order_number,
           o.store_id,
           st.name AS store_name,
           o.tags,
           o.total_value_cents,
           o.currency,
           o.payment_method,
           (SELECT count(*)::int FROM shipments s WHERE s.order_id = o.id) AS parcels
      FROM orders o
      JOIN stores st ON st.id = o.store_id
     WHERE st.platform = 'shopify'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(o.tags) AS tag
          WHERE tag LIKE ${`${TIKTOK_TAG_PREFIX}%`}
       )
     ORDER BY o.order_number
  `);

  return rowsOf<RawTaggedOrder>(result).map((r) => ({
    orderId: r.order_id,
    orderNumber: r.order_number,
    storeId: r.store_id,
    storeName: r.store_name,
    // Read in JS by the same function the ingest guard uses, so "what counts
    // as a TikTok order id" has one definition.
    tiktokOrderId: tiktokOrderIdFromTags(r.tags),
    parcels: Number(r.parcels),
    valueCents: Number(r.total_value_cents),
    currency: r.currency ?? 'EUR',
    paymentMethod: r.payment_method ?? 'prepaid',
  }));
}

function summarise(tagged: TaggedOrder[]): HandoverPreview {
  const byStore = new Map<string, { orders: number; parcels: number }>();
  for (const o of tagged) {
    const seen = byStore.get(o.storeName) ?? { orders: 0, parcels: 0 };
    seen.orders += 1;
    seen.parcels += o.parcels;
    byStore.set(o.storeName, seen);
  }

  return {
    tiktokOrders: tagged.length,
    parcelsToMove: tagged.filter((o) => o.tiktokOrderId).reduce((n, o) => n + o.parcels, 0),
    emptyRows: tagged.filter((o) => o.tiktokOrderId && o.parcels === 0).length,
    unreadableTags: tagged.filter((o) => !o.tiktokOrderId).length,
    byStore: [...byStore.entries()]
      .map(([store, n]) => ({ store, ...n }))
      .sort((a, b) => b.parcels - a.parcels),
  };
}

/** Nothing is written. The numbers the button is about to act on. */
export async function previewTikTokHandover(): Promise<HandoverPreview> {
  return summarise(await taggedShopifyOrders());
}

export async function applyTikTokHandover(): Promise<HandoverResult> {
  const tagged = await taggedShopifyOrders();
  const preview = summarise(tagged);
  const movable = tagged.filter((o) => o.tiktokOrderId);

  if (!movable.length) {
    return { ...preview, moved: 0, ordersRemoved: 0, tiktokOrdersCreated: 0 };
  }

  /*
   * The TikTok shop, created the first time one of its orders turns up — the
   * same way lib/import/commit.ts does it, from the same spec, so a handover
   * on a system that has never had an upload still lands somewhere sensible.
   */
  const spec = SOURCE_STORE.tiktok;
  const [tiktokStore] = await getDb().insert(stores).values({
    key: spec.key,
    name: spec.name,
    platform: spec.platform,
    ingest: 'manual',
  }).onConflictDoUpdate({ target: stores.key, set: { active: true } })
    .returning({ id: stores.id });

  const at = now();
  let moved = 0;
  let ordersRemoved = 0;
  let tiktokOrdersCreated = 0;
  let firstShipmentId: string | null = null;

  for (const o of movable) {
    const tiktokOrderId = o.tiktokOrderId as string;

    /*
     * ONE TRANSACTION PER ORDER. The parcel is re-pointed and the old row
     * deleted together, so a failure halfway through the list leaves earlier
     * orders finished, later ones untouched, and no parcel without an order.
     *
     * Everything inside uses `tx`. With `DB_POOL_MAX=1` on Vercel a `getDb()`
     * call in here would ask the pool for a second connection while this
     * transaction holds the only one, and wait for itself until
     * `connect_timeout`. That is also why the ticker line is written after the
     * loop rather than inside it: `say()` takes its own connection.
     */
    // eslint-disable-next-line no-await-in-loop
    await getDb().transaction(async (tx) => {
      const [target] = await tx.insert(orders).values({
        storeId: tiktokStore.id,
        externalOrderId: tiktokOrderId,
        // Both the TikTok id, which is what the upload writes.
        orderNumber: tiktokOrderId,
        // The empty string, not "Unknown customer": these orders have no name
        // in TikTok's own files either, and a placeholder leaks into the
        // Spanish message as "Hola Unknown". See lib/orders/customer-label.ts.
        customerName: '',
        phoneE164: null,
        phoneRaw: null,
        phoneStatus: 'missing',
        email: null,
        addressLine: null,
        city: null,
        postalCode: null,
        /*
         * The money comes across, because it is the same money. Everything
         * else is left as the upload would have it, but `value` and
         * `payment_method` are what the escalation engine ranks by — a parcel
         * written down as €0 would quietly sink to the bottom of the list it
         * was moved onto.
         */
        totalValueCents: o.valueCents,
        currency: o.currency,
        paymentMethod: o.paymentMethod,
        // Null, not the ship date: TikTok's files carry no order date, and the
        // screens show "—" rather than claiming it was ordered the day it was
        // posted.
        placedAt: null,
        createdAt: at,
      }).onConflictDoUpdate({
        target: [orders.storeId, orders.externalOrderId],
        /*
         * A no-op write of the id it already has. The row may exist because
         * the upload created it, and in that case the upload owns its
         * contents — but `DO NOTHING` returns no row, and this needs the id.
         */
        set: { externalOrderId: tiktokOrderId },
      }).returning({ id: orders.id, fresh: raw<boolean>`(xmax = 0)` });

      if (target.fresh) tiktokOrdersCreated += 1;

      // The ROW moves. Its id, state, events, contact log, tasks and closures
      // are all untouched, which is the whole point of not recreating it.
      const movedRows = await tx.update(shipments)
        .set({ orderId: target.id })
        .where(eq(shipments.orderId, o.orderId))
        .returning({ id: shipments.id });

      moved += movedRows.length;
      if (!firstShipmentId && movedRows[0]) firstShipmentId = movedRows[0].id;

      /*
       * And the Shopify row goes — but only once nothing points at it.
       * `shipments.order_id` is ON DELETE CASCADE, so an unguarded delete
       * would take the parcel with it. The guard is belt and braces with the
       * update above, and it is what makes the already-empty rows (the ones
       * the upload beat us to) disappear in the same pass.
       */
      const removed = await tx.delete(orders)
        .where(and(
          eq(orders.id, o.orderId),
          raw`NOT EXISTS (SELECT 1 FROM shipments WHERE shipments.order_id = orders.id)`,
        ))
        .returning({ id: orders.id });

      ordersRemoved += removed.length;
    });
  }

  if (moved > 0 || ordersRemoved > 0) {
    const from = preview.byStore.length === 1 ? preview.byStore[0].store : 'Shopify';
    await say(
      `Moved ${moved} TikTok ${moved === 1 ? 'parcel' : 'parcels'} from ${from} to ${spec.name}`,
      firstShipmentId ?? undefined,
    );
  }

  return { ...preview, moved, ordersRemoved, tiktokOrdersCreated };
}
