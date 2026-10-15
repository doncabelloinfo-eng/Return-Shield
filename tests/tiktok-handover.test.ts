import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  activity, contactLog, orders, shipmentEvents, shipments, stores, users,
} from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { buildPreview, parseFile } from '@/lib/import/parse';
import { commitImport } from '@/lib/import/commit';
import {
  applyTikTokHandover, previewTikTokHandover, taggedShopifyOrders,
} from '@/lib/orders/tiktok-handover';
import { resetDb, closeDb } from './helpers/db';

/**
 * Giving back the TikTok orders Shopify already handed us.
 *
 * The channel check (tests/shopify-channel.test.ts) stops it happening again.
 * This is the 96 already in: parcels sitting under "Don Cabello Profesional"
 * with #22xxx Shopify order numbers, which the TikTok Shop filter cannot see,
 * and which the TikTok upload skips as duplicates.
 *
 * THE TWO THINGS THAT MUST NOT GO WRONG, and most of this file is about them.
 *
 * The shipment ROW moves; it is never recreated. Its id is what the events,
 * the contact log, the tasks and the closures all hang off, so recreating it
 * would throw away the parcel's whole tracking history — and the history is
 * the reason the system exists.
 *
 * And `shipments.order_id` is ON DELETE CASCADE. Deleting the Shopify order
 * row before its parcel has moved would delete the parcel. The delete is
 * guarded by "nothing points at it", which is the only reason that is safe.
 */

const SHOPIFY_STORE = 'handovertest';
const TIKTOK_ID = '576967097623484645';

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-15T10:00:00+02:00');
  clock.install();

  await getDb().insert(stores).values({
    key: SHOPIFY_STORE, name: 'Don Cabello Profesional', platform: 'shopify', ingest: 'auto',
  });
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

async function shopifyStoreId(): Promise<string> {
  const [row] = await getDb().select({ id: stores.id }).from(stores)
    .where(eq(stores.key, SHOPIFY_STORE)).limit(1);
  return row.id;
}

/** A Shopify order as the webhook wrote it, TikTok tags and all. */
async function shopifyOrder(opts: {
  number: string;
  tiktokId?: string | null;
  tags?: string[];
  code?: string;
  valueCents?: number;
}): Promise<{ orderId: string; shipmentId: string | null }> {
  const tags = opts.tags ?? (opts.tiktokId
    ? ['Shipped by Seller', `TikTokOrderID:${opts.tiktokId}`, 'NORMAL']
    : []);

  const [order] = await getDb().insert(orders).values({
    storeId: await shopifyStoreId(),
    externalOrderId: `shopify-${opts.number}`,
    orderNumber: opts.number,
    customerName: 'Lucía Fernández Ortiz',
    phoneE164: '+34627481093',
    phoneRaw: '+34 627 481 093',
    phoneStatus: 'ok',
    email: 'lucia@example.com',
    addressLine: 'C/ Toledo 44',
    city: 'Getafe, Madrid',
    postalCode: '28901',
    totalValueCents: opts.valueCents ?? 4190,
    currency: 'EUR',
    paymentMethod: 'cod',
    placedAt: new Date('2026-10-13T09:00:00Z'),
    tags,
    createdAt: clock.now(),
  }).returning({ id: orders.id });

  if (!opts.code) return { orderId: order.id, shipmentId: null };

  const [ship] = await getDb().insert(shipments).values({
    orderId: order.id,
    carrier: 'correos',
    shippingCode: opts.code,
    productCode: 'PAQ ESTÁNDAR',
    state: 'at_office',
    stateSince: new Date('2026-10-14T11:00:00Z'),
    shippedAt: new Date('2026-10-13T11:00:00Z'),
    createdAt: clock.now(),
  }).returning({ id: shipments.id });

  return { orderId: order.id, shipmentId: ship.id };
}

async function tiktokStore(): Promise<string> {
  const [row] = await getDb().insert(stores).values({
    key: 'tiktok-es', name: 'TikTok Shop ES', platform: 'tiktok', ingest: 'manual',
  }).onConflictDoUpdate({ target: stores.key, set: { active: true } })
    .returning({ id: stores.id });
  return row.id;
}

/** Where a parcel lives now: its shop and its order number. */
async function homeOf(shipmentId: string): Promise<{ store: string; orderNumber: string }> {
  const [row] = await getDb().select({
    store: stores.name,
    orderNumber: orders.orderNumber,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  return row;
}

/* ============================================================== the preview */

describe('the preview', () => {
  it('counts the tagged orders, the parcels and the empty rows', async () => {
    await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });
    await shopifyOrder({ number: '#22686', tiktokId: '576967097623484646', code: 'PKA6TP9800094740148904F' });
    // The upload got to this one first, so the Shopify row has no parcel.
    await shopifyOrder({ number: '#22687', tiktokId: '576967097623484647' });
    // And an Online Store order, which is none of this action's business.
    await shopifyOrder({ number: '#22688', code: 'PQ3000012345ES' });

    const preview = await previewTikTokHandover();

    expect(preview.tiktokOrders).toBe(3);
    expect(preview.parcelsToMove).toBe(2);
    expect(preview.emptyRows).toBe(1);
    expect(preview.unreadableTags).toBe(0);
    // Both parcels carry a Shopify phone and email, and the move discards
    // them: said before the button, because it cannot be undone.
    expect(preview.parcelsLosingContact).toBe(2);
    expect(preview.byStore).toEqual([{ store: 'Don Cabello Profesional', orders: 3, parcels: 2 }]);
  });

  it('writes nothing', async () => {
    await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });
    await previewTikTokHandover();

    expect(await getDb().select({ id: orders.id }).from(orders)).toHaveLength(1);
    expect(await getDb().select({ id: activity.id }).from(activity)).toHaveLength(0);
    expect(await getDb().select({ id: stores.id }).from(stores)).toHaveLength(1);
  });

  it('equals what the apply then does', async () => {
    // The brief's own requirement, and the reason both halves run one query.
    await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });
    await shopifyOrder({ number: '#22686', tiktokId: '576967097623484646', code: 'PKA6TP9800094740148904F' });
    await shopifyOrder({ number: '#22687', tiktokId: '576967097623484647' });

    const preview = await previewTikTokHandover();
    const result = await applyTikTokHandover();

    expect(result.moved).toBe(preview.parcelsToMove);
    expect(result.ordersRemoved).toBe(preview.tiktokOrders);
    expect(result.tiktokOrders).toBe(preview.tiktokOrders);
  });

  it('ignores a tag nobody can read an id out of', async () => {
    await shopifyOrder({
      number: '#22689',
      tags: ['Shipped by Seller', 'TikTokOrderID:', 'NORMAL'],
      code: 'PQ3000099999ES',
    });

    const preview = await previewTikTokHandover();
    expect(preview.tiktokOrders).toBe(1);
    expect(preview.unreadableTags).toBe(1);
    expect(preview.parcelsToMove).toBe(0);

    // And the apply leaves it exactly where it is rather than guessing an id.
    const result = await applyTikTokHandover();
    expect(result.moved).toBe(0);
    expect(result.ordersRemoved).toBe(0);
    expect(await getDb().select({ id: orders.id }).from(orders)).toHaveLength(1);
  });
});

/* ================================================================ the apply */

describe('the apply', () => {
  it('moves the parcel to a TikTok order that already exists', async () => {
    const tiktokStoreId = await tiktokStore();
    const [existing] = await getDb().insert(orders).values({
      storeId: tiktokStoreId,
      externalOrderId: TIKTOK_ID,
      orderNumber: TIKTOK_ID,
      customerName: '',
      phoneStatus: 'missing',
      totalValueCents: 4190,
      paymentMethod: 'prepaid',
      placedAt: null,
      createdAt: clock.now(),
    }).returning({ id: orders.id });

    const { shipmentId } = await shopifyOrder({
      number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F',
    });

    const result = await applyTikTokHandover();

    expect(result.moved).toBe(1);
    expect(result.tiktokOrdersCreated).toBe(0);
    expect(await homeOf(shipmentId!)).toEqual({ store: 'TikTok Shop ES', orderNumber: TIKTOK_ID });

    const [row] = await getDb().select({ orderId: shipments.orderId }).from(shipments)
      .where(eq(shipments.id, shipmentId!));
    expect(row.orderId).toBe(existing.id);
  });

  it('creates the TikTok order when there is none yet, the way the upload would', async () => {
    const { shipmentId } = await shopifyOrder({
      number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F', valueCents: 6490,
    });

    const result = await applyTikTokHandover();
    expect(result.moved).toBe(1);
    expect(result.tiktokOrdersCreated).toBe(1);

    const [shop] = await getDb().select().from(stores).where(eq(stores.key, 'tiktok-es'));
    expect(shop.name).toBe('TikTok Shop ES');
    expect(shop.platform).toBe('tiktok');
    expect(shop.ingest).toBe('manual');

    const [order] = await getDb().select().from(orders).where(eq(orders.externalOrderId, TIKTOK_ID));
    expect(order.orderNumber).toBe(TIKTOK_ID);
    // Empty, not "Unknown customer": the Spanish message says "Hola," and the
    // screens label it. See lib/orders/customer-label.ts.
    expect(order.customerName).toBe('');
    expect(order.phoneE164).toBeNull();
    expect(order.email).toBeNull();
    expect(order.addressLine).toBeNull();
    expect(order.city).toBeNull();
    // No order date, like every marketplace row. The screen shows "—".
    expect(order.placedAt).toBeNull();
    // The money does come across: it is the same money, and it is what the
    // escalation engine ranks by.
    expect(order.totalValueCents).toBe(6490);
    expect(order.paymentMethod).toBe('cod');

    expect(await homeOf(shipmentId!)).toEqual({ store: 'TikTok Shop ES', orderNumber: TIKTOK_ID });
  });

  it('removes the Shopify order row, and the already-empty ones too', async () => {
    await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });
    await shopifyOrder({ number: '#22687', tiktokId: '576967097623484647' });

    const result = await applyTikTokHandover();
    expect(result.ordersRemoved).toBe(2);

    const left = await getDb().select({ number: orders.orderNumber, storeId: orders.storeId })
      .from(orders);
    // Only the TikTok order the parcel moved to.
    expect(left).toHaveLength(1);
    expect(left[0].number).toBe(TIKTOK_ID);
  });

  it('creates NO TikTok order for a tagged row that has no parcel', async () => {
    /*
     * The bug this test exists for. The first version upserted the TikTok
     * order for every tagged row, so an empty Shopify row — one the upload got
     * to first — created a brand-new TikTok order with nothing in it, counted
     * it as created, and left it behind. Seen on the built server: `#22689`
     * went, and `tiktok-es` order 576967097623484649 was left holding nothing.
     */
    await shopifyOrder({ number: '#22689', tiktokId: '576967097623484649' });
    await shopifyOrder({ number: '#22690', tiktokId: '576967097623484650' });

    const result = await applyTikTokHandover();

    expect(result.moved).toBe(0);
    expect(result.ordersRemoved).toBe(2);
    expect(result.tiktokOrdersCreated).toBe(0);

    // Nothing left anywhere: not the Shopify rows, and no empty TikTok ones.
    expect(await getDb().select({ id: orders.id }).from(orders)).toHaveLength(0);
  });

  it('still removes an empty row whose TikTok order DOES exist', async () => {
    // The ordinary case for the second half of the job: the parcel is already
    // under TikTok Shop ES, and only the Shopify leftover needs removing.
    const tiktokStoreId = await tiktokStore();
    const [kept] = await getDb().insert(orders).values({
      storeId: tiktokStoreId,
      externalOrderId: TIKTOK_ID,
      orderNumber: TIKTOK_ID,
      customerName: '',
      phoneStatus: 'missing',
      totalValueCents: 4190,
      paymentMethod: 'prepaid',
      placedAt: null,
      createdAt: clock.now(),
    }).returning({ id: orders.id });

    await getDb().insert(shipments).values({
      orderId: kept.id,
      carrier: 'correos',
      shippingCode: 'PKA6TP9800094740148903F',
      productCode: 'PAQ ESTÁNDAR',
      state: 'at_office',
      createdAt: clock.now(),
    });

    await shopifyOrder({ number: '#22687', tiktokId: TIKTOK_ID });

    const result = await applyTikTokHandover();

    expect(result.moved).toBe(0);
    expect(result.ordersRemoved).toBe(1);
    expect(result.tiktokOrdersCreated).toBe(0);

    // The TikTok order and its parcel are exactly as they were.
    expect(await getDb().select({ id: orders.id }).from(orders)).toHaveLength(1);
    expect(await getDb().select({ id: shipments.id }).from(shipments)).toHaveLength(1);
  });

  it('says what it did when all it did was remove empty rows', async () => {
    // "Moved 0 TikTok parcels" was the one permanent record of a run that
    // deleted fifteen rows.
    await shopifyOrder({ number: '#22689', tiktokId: '576967097623484649' });

    await applyTikTokHandover();

    const lines = await getDb().select({ text: activity.text }).from(activity);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe(
      'Removed 1 empty Shopify order row from Don Cabello Profesional '
      + '— those TikTok parcels are already under TikTok Shop ES',
    );
  });

  it('does not touch an Online Store order', async () => {
    const { orderId, shipmentId } = await shopifyOrder({ number: '#22688', code: 'PQ3000012345ES' });
    await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });

    await applyTikTokHandover();

    const [kept] = await getDb().select().from(orders).where(eq(orders.id, orderId));
    expect(kept).toBeDefined();
    expect(kept.orderNumber).toBe('#22688');
    expect(kept.customerName).toBe('Lucía Fernández Ortiz');
    expect(await homeOf(shipmentId!)).toEqual({
      store: 'Don Cabello Profesional', orderNumber: '#22688',
    });
  });

  it('keeps the parcel whole: same id, state, events and contact log', async () => {
    const { shipmentId } = await shopifyOrder({
      number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F',
    });

    await getDb().insert(shipmentEvents).values([{
      shipmentId: shipmentId!,
      rawPayload: {},
      eventCode: 'A090000V',
      eventDesc: 'Prerregistrado',
      occurredAt: new Date('2026-10-13T09:00:00Z'),
      receivedAt: clock.now(),
      source: 'poll',
      mappedState: 'created',
    }, {
      shipmentId: shipmentId!,
      rawPayload: {},
      eventCode: 'G01L010V',
      eventDesc: 'Disponible en oficina',
      occurredAt: new Date('2026-10-14T11:00:00Z'),
      receivedAt: clock.now(),
      source: 'poll',
      mappedState: 'at_office',
    }]);

    const [user] = await getDb().insert(users).values({
      email: 'op@example.com', name: 'Op', passwordHash: 'x',
    }).returning({ id: users.id });

    await getDb().insert(contactLog).values({
      shipmentId: shipmentId!,
      at: clock.now(),
      outcome: 'Said they would collect',
      note: 'rang her',
      userId: user.id,
    });

    await applyTikTokHandover();

    // The SAME row, not a new one with the same code.
    const [after] = await getDb().select().from(shipments).where(eq(shipments.id, shipmentId!));
    expect(after).toBeDefined();
    expect(after.state).toBe('at_office');
    expect(after.shippingCode).toBe('PKA6TP9800094740148903F');
    expect(after.stateSince?.toISOString()).toBe('2026-10-14T11:00:00.000Z');

    expect(await getDb().select().from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, shipmentId!))).toHaveLength(2);
    expect(await getDb().select().from(contactLog)
      .where(eq(contactLog.shipmentId, shipmentId!))).toHaveLength(1);
  });

  it('writes one ticker line, naming the shop it came from', async () => {
    await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });
    await shopifyOrder({ number: '#22686', tiktokId: '576967097623484646', code: 'PKA6TP9800094740148904F' });

    await applyTikTokHandover();

    const lines = await getDb().select({ text: activity.text }).from(activity);
    expect(lines).toHaveLength(1);
    expect(lines[0].text)
      .toBe('Moved 2 TikTok parcels from Don Cabello Profesional to TikTok Shop ES');
  });

  it('finds nothing the second time', async () => {
    await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });
    await shopifyOrder({ number: '#22687', tiktokId: '576967097623484647' });

    const first = await applyTikTokHandover();
    expect(first.moved).toBe(1);

    const again = await applyTikTokHandover();
    expect(again.tiktokOrders).toBe(0);
    expect(again.moved).toBe(0);
    expect(again.ordersRemoved).toBe(0);
    expect(again.tiktokOrdersCreated).toBe(0);
    // And no second ticker line about having done nothing.
    expect(await getDb().select({ id: activity.id }).from(activity)).toHaveLength(1);
    expect(await taggedShopifyOrders()).toEqual([]);
  });

  it('sends two Shopify orders carrying the same TikTok id to one order', async () => {
    // Not expected, but a tag is only a string: two Shopify rows could carry
    // the same id, and the second must not fail on the unique index.
    const a = await shopifyOrder({ number: '#22685', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148903F' });
    const b = await shopifyOrder({ number: '#22686', tiktokId: TIKTOK_ID, code: 'PKA6TP9800094740148904F' });

    const result = await applyTikTokHandover();

    expect(result.moved).toBe(2);
    expect(result.tiktokOrdersCreated).toBe(1);
    expect((await homeOf(a.shipmentId!)).orderNumber).toBe(TIKTOK_ID);
    expect((await homeOf(b.shipmentId!)).orderNumber).toBe(TIKTOK_ID);
  });
});

/* ===================================== and then the upload, as it was before */

describe('after the handover', () => {
  it('a TikTok file holding a moved order skips it, and the parcel stays put', async () => {
    const code = 'PKA6TP9800094740148903F';
    const { shipmentId } = await shopifyOrder({
      number: '#22685', tiktokId: TIKTOK_ID, code,
    });
    await applyTikTokHandover();

    // The real upload path: parse, dedupe against what is in the database,
    // then commit what the preview allowed.
    const header = 'order-id\torder-item-id\tquantity\tship-date\tcarrier-code\tcarrier-name'
      + '\ttracking-number\tship-method\t';
    const line = [TIKTOK_ID, '', '', '2026-10-13', 'Correos', '', code, 'PAQ PREMIUM'].join('\t');
    const parsed = await parseFile('tiktok shop.txt', Buffer.from([header, line].join('\n'), 'utf8'));

    const codes = parsed.rows.map((r) => (r.shipping_code ?? '').trim().toUpperCase()).filter(Boolean);
    const known = new Set<string>((await getDb().select({ code: shipments.shippingCode }).from(shipments)
      .where(inArray(shipments.shippingCode, codes))).map((r) => r.code));
    const { rows: preview } = buildPreview(parsed.rows, known, parsed.format);

    expect(preview[0].status).toBe('duplicate');

    const [user] = await getDb().insert(users).values({
      email: 'op2@example.com', name: 'Op', passwordHash: 'x',
    }).returning({ id: users.id });

    const committed = await commitImport({
      storeKey: 'tiktok-es', filename: 'tiktok shop.txt', userId: user.id, rows: preview, fixes: {},
    });

    expect(committed.created).toBe(0);
    expect(committed.skipped).toBe(1);

    // Still the same parcel row, still under TikTok Shop ES.
    expect(await getDb().select({ id: shipments.id }).from(shipments)).toHaveLength(1);
    expect(await homeOf(shipmentId!)).toEqual({ store: 'TikTok Shop ES', orderNumber: TIKTOK_ID });
  });
});
