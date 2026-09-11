import { db } from '@/db';
import { offices, orders, productRules, shipments, stores } from '@/db/schema';

/**
 * One parcel, set up the way the real system sets one up. Everything a test
 * varies is a named argument with a sensible default, so a test reads as the
 * one thing it is about.
 */
export interface MakeShipmentOptions {
  shippingCode?: string;
  productCode?: string;
  depositDays?: number;
  valueCents?: number;
  paymentMethod?: 'prepaid' | 'cod';
  customerName?: string;
  phone?: string | null;
  placedAt?: Date;
  storeName?: string;
  postalCode?: string;
}

export interface Fixture {
  storeId: string;
  orderId: string;
  shipmentId: string;
  shippingCode: string;
  officeCode: string;
}

export async function makeShipment(opts: MakeShipmentOptions = {}): Promise<Fixture> {
  const shippingCode = opts.shippingCode ?? `PQ${Math.floor(Math.random() * 1e10)}ES`;
  const productCode = opts.productCode ?? 'PAQ ESTÁNDAR';

  await db.insert(productRules).values({
    productCode,
    depositDays: opts.depositDays ?? 15,
    label: 'test',
    confirmedWithCarrier: false,
  }).onConflictDoUpdate({
    target: productRules.productCode,
    set: { depositDays: opts.depositDays ?? 15 },
  });

  const [store] = await db.insert(stores).values({
    key: 'test-store',
    name: opts.storeName ?? 'Cosmetics Afro Latino',
    platform: 'shopify',
    ingest: 'auto',
  }).onConflictDoUpdate({
    target: stores.key,
    set: { name: opts.storeName ?? 'Cosmetics Afro Latino' },
  }).returning({ id: stores.id });

  const [order] = await db.insert(orders).values({
    storeId: store.id,
    externalOrderId: `ext-${shippingCode}`,
    orderNumber: `ORD-${shippingCode.slice(-4)}`,
    customerName: opts.customerName ?? 'Lucía Fernández Ortiz',
    phoneE164: opts.phone === null ? null : (opts.phone ?? '+34627481093'),
    phoneRaw: opts.phone ?? '+34 627 481 093',
    phoneStatus: opts.phone === null ? 'missing' : 'ok',
    email: 'lucia.fernandez91@example.com',
    addressLine: 'C/ Toledo 44, 3ºB',
    city: 'Getafe, Madrid',
    postalCode: opts.postalCode ?? '28901',
    totalValueCents: opts.valueCents ?? 6490,
    paymentMethod: opts.paymentMethod ?? 'cod',
    placedAt: opts.placedAt ?? new Date('2026-09-01T08:00:00Z'),
  }).returning({ id: orders.id });

  const [ship] = await db.insert(shipments).values({
    orderId: order.id,
    shippingCode,
    productCode,
    state: 'created',
  }).returning({ id: shipments.id });

  const officeCode = 'OF-MAD-12';
  await db.insert(offices).values({
    correosCode: officeCode,
    name: 'Oficina Madrid Sucursal 12',
    address: 'C/ Mejía Lequerica 8, 28004 Madrid',
    openingHours: 'L–V 08:30–20:30 · S 09:30–13:00',
  }).onConflictDoNothing();

  return {
    storeId: store.id,
    orderId: order.id,
    shipmentId: ship.id,
    shippingCode,
    officeCode,
  };
}

/** A Correos push body, in the shape their swagger describes. */
export function correosPush(
  shippingCode: string,
  events: { code: string; desc: string; date: string; time: string; office?: string }[],
) {
  return {
    codEnvio: shippingCode,
    eventos: events.map((e) => ({
      codEvento: e.code,
      desEvento: e.desc,
      fecEvento: e.date,
      horEvento: e.time,
      ...(e.office
        ? { codOficina: e.office, desOficina: 'Oficina Madrid Sucursal 12', dirOficina: 'C/ Mejía Lequerica 8, 28004 Madrid' }
        : {}),
    })),
  };
}
