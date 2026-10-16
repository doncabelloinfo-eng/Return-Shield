import { getDb } from '@/db';
import { offices, orders, productRules, scans, shipments, stores, users } from '@/db/schema';
import { hashPassword } from '@/lib/auth/password';
import type { UserRole } from '@/lib/auth/roles';
import { parseCorreosCode } from '@/lib/scan/codes';
import { openBatch } from '@/lib/scan/batches';
import type { ScanDirection, ScanSource } from '@/lib/scan/model';

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
  /** For the Parcels screen and the retention window. */
  state?: string;
  stateSince?: Date;
  /** The day the order came in. What the rolling 30-day window measures. */
  orderCreatedAt?: Date;
  city?: string;
  /** A separate shop, for testing the shop filter. */
  storeKey?: string;
  orderNumber?: string;
  /** The shop's myshopify host. Needed by the "Open in Shopify" link. */
  shopDomain?: string | null;
  /** Shopify's numeric order id. The default is deliberately not numeric. */
  externalOrderId?: string;
  /** `shopify` unless a test is about what a marketplace row looks like. */
  platform?: 'shopify' | 'tiktok' | 'amazon';
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

  await getDb().insert(productRules).values({
    productCode,
    depositDays: opts.depositDays ?? 15,
    label: 'test',
    confirmedWithCarrier: false,
  }).onConflictDoUpdate({
    target: productRules.productCode,
    set: { depositDays: opts.depositDays ?? 15 },
  });

  const storeKey = opts.storeKey ?? 'test-store';
  const [store] = await getDb().insert(stores).values({
    key: storeKey,
    name: opts.storeName ?? 'Cosmetics Afro Latino',
    platform: opts.platform ?? 'shopify',
    ingest: 'auto',
    ...(opts.shopDomain !== undefined ? { shopDomain: opts.shopDomain } : {}),
  }).onConflictDoUpdate({
    target: stores.key,
    set: {
      name: opts.storeName ?? 'Cosmetics Afro Latino',
      ...(opts.shopDomain !== undefined ? { shopDomain: opts.shopDomain } : {}),
    },
  }).returning({ id: stores.id });

  const [order] = await getDb().insert(orders).values({
    storeId: store.id,
    externalOrderId: opts.externalOrderId ?? `ext-${shippingCode}`,
    orderNumber: opts.orderNumber ?? `ORD-${shippingCode.slice(-4)}`,
    customerName: opts.customerName ?? 'Lucía Fernández Ortiz',
    phoneE164: opts.phone === null ? null : (opts.phone ?? '+34627481093'),
    phoneRaw: opts.phone ?? '+34 627 481 093',
    phoneStatus: opts.phone === null ? 'missing' : 'ok',
    email: 'lucia.fernandez91@example.com',
    addressLine: 'C/ Toledo 44, 3ºB',
    city: opts.city ?? 'Getafe, Madrid',
    postalCode: opts.postalCode ?? '28901',
    totalValueCents: opts.valueCents ?? 6490,
    paymentMethod: opts.paymentMethod ?? 'cod',
    placedAt: opts.placedAt ?? new Date('2026-09-01T08:00:00Z'),
    // Explicit, because the rolling retention window measures from this and a
    // test about "an order from 31 days back" cannot use defaultNow().
    ...(opts.orderCreatedAt ? { createdAt: opts.orderCreatedAt } : {}),
  }).returning({ id: orders.id });

  const [ship] = await getDb().insert(shipments).values({
    orderId: order.id,
    shippingCode,
    productCode,
    state: opts.state ?? 'created',
    stateSince: opts.stateSince ?? null,
    ...(opts.orderCreatedAt ? { createdAt: opts.orderCreatedAt } : {}),
  }).returning({ id: shipments.id });

  const officeCode = 'OF-MAD-12';
  await getDb().insert(offices).values({
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

/* --------------------------------------------------------------------- users */

export interface MakeUserOptions {
  email?: string;
  name?: string;
  /** `operator` is the default, exactly as the column's own default is. */
  role?: UserRole;
  /** Hashed properly when given, so a sign-in test can actually sign in. */
  password?: string;
  disabled?: boolean;
}

export interface UserFixture {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/**
 * One account. The Scanner put two kinds in the database, so a test that cares
 * which kind has to be able to say so in one line.
 */
export async function makeUser(opts: MakeUserOptions = {}): Promise<UserFixture> {
  const role: UserRole = opts.role ?? 'operator';
  const email = (opts.email ?? `${role}-${Math.floor(Math.random() * 1e9)}@example.com`).toLowerCase();
  const name = opts.name ?? (role === 'scanner' ? 'Warehouse' : 'Op');

  const [row] = await getDb().insert(users).values({
    email,
    name,
    // `scrypt` with the production parameters takes about a tenth of a second,
    // so a test that does not sign in does not pay for it.
    passwordHash: opts.password ? await hashPassword(opts.password) : 'x',
    role,
    ...(opts.disabled ? { disabledAt: new Date('2026-10-01T00:00:00Z') } : {}),
  }).returning({ id: users.id });

  return { id: row.id, email, name, role };
}

/* --------------------------------------------------------------------- scans */

export interface MakeScanOptions {
  /** The code as the warehouse read it. Parsed, so it must be a real one. */
  code: string;
  /** Who scanned it. A real row: `scans.user_id` is a foreign key. */
  userId: string;
  direction?: ScanDirection;
  at?: Date;
  source?: ScanSource;
  /** Reuse an open batch instead of this worker's current one. */
  batchId?: string;
  /**
   * The order number and shop copied onto the scan when it was taken.
   *
   * Left null by default, so a test has to ASK for the copy — which is the
   * thing being tested when a matched return has to survive its parcel being
   * cleaned up.
   */
  orderNumber?: string | null;
  storeName?: string | null;
}

/**
 * One scan, written straight to the table.
 *
 * For setting up what the panel then reads. A test about the scanning path
 * itself should go through `addScan`, which is what the phone calls and which
 * does the matching, the copying and the duplicate rule.
 */
export async function makeScan(opts: MakeScanOptions): Promise<{ id: string; batchId: string }> {
  const code = parseCorreosCode(opts.code);
  if (!code) throw new Error(`makeScan: "${opts.code}" is not a Correos code`);

  const direction = opts.direction ?? 'outgoing';
  const batchId = opts.batchId ?? (await openBatch(opts.userId, direction)).id;

  const [row] = await getDb().insert(scans).values({
    batchId,
    direction,
    userId: opts.userId,
    scannedAt: opts.at ?? new Date(),
    codeAsRead: code.raw,
    base: code.base,
    parcelNo: code.parcelNo,
    postalCode: code.postalCode,
    source: opts.source ?? 'barcode',
    readIds: [`fixture-${Math.random().toString(36).slice(2)}`],
    timesRead: 1,
    orderNumber: opts.orderNumber ?? null,
    storeName: opts.storeName ?? null,
  }).returning({ id: scans.id });

  return { id: row.id, batchId };
}
