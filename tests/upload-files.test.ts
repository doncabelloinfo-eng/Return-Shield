import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { importBatches, orders, shipments, stores, users } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import {
  parseFile, buildPreview, detectSource, formatOf, isCorreosCarrier, productCodeOf,
} from '@/lib/import/parse';
import { commitImport } from '@/lib/import/commit';
import { customerLabel } from '@/lib/orders/customer-label';
import { resetDb, closeDb } from './helpers/db';

/**
 * The marketplace shipping-confirmation files.
 *
 * Amazon and TikTok export the SAME eight columns, so which marketplace a row
 * came from has to come out of the order id. The file name cannot be trusted:
 * one real file was `Seguimiento_Amazon_07102026_015340.txt` and the other was
 * `tiktok shop.txt`, and people rename these.
 *
 * Every value below is synthetic. The shapes are real; the orders are not.
 */

const HEADER = 'order-id\torder-item-id\tquantity\tship-date\tcarrier-code\tcarrier-name'
  + '\ttracking-number\tship-method\t';

interface Row {
  orderId: string;
  itemId?: string;
  quantity?: string;
  shipDate?: string;
  carrierCode?: string;
  carrierName?: string;
  tracking: string;
  shipMethod?: string;
}

/** A file in the real shape, trailing tab on the header and all. */
function file(rows: Row[]): Buffer {
  const lines = rows.map((r) => [
    r.orderId,
    r.itemId ?? '',
    r.quantity ?? '',
    r.shipDate ?? '2026-10-06',
    r.carrierCode ?? 'Correos',
    r.carrierName ?? '',
    r.tracking,
    r.shipMethod ?? 'PAQ PREMIUM',
  ].join('\t'));

  return Buffer.from([HEADER, ...lines].join('\n'), 'utf8');
}

const amazon = (n: number, over: Partial<Row> = {}): Row => ({
  orderId: `404-0000000-000000${n}`,
  itemId: `1000000000000${n}`,
  quantity: '1',
  tracking: `PKA6TP980000000000000${n}X`,
  ...over,
});

const tiktok = (n: number, over: Partial<Row> = {}): Row => ({
  orderId: `57690000000000000${n}`,
  tracking: `PKA6TP980000000000001${n}X`,
  ...over,
});

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T10:00:00+02:00');
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

/* ========================================================================== */

describe('telling the two marketplaces apart', () => {
  it.each([
    ['404-0000000-0000001', 'amazon'],
    ['404-1234567-7654321', 'amazon'],
    ['576900000000000001', 'tiktok'],
    ['5769000000000001', 'tiktok'],
  ])('reads %s as %s', (id, source) => {
    expect(detectSource(id)).toBe(source);
  });

  it.each([
    ['5.76962E+17', 'excel_damaged'],
    ['5.7E+17', 'excel_damaged'],
  ])('refuses %s, which Excel destroyed', (id, source) => {
    // The digits are gone. There is nothing to recover and nothing to guess.
    expect(detectSource(id)).toBe(source);
  });

  it.each([
    ['', 'unknown'],
    ['ORD-1234', 'unknown'],
    ['404-00-0001', 'unknown'],
    ['12345', 'unknown'],
    ['not an order', 'unknown'],
  ])('cannot place %j', (id, source) => {
    expect(detectSource(id)).toBe(source);
  });

  it('does not require the 5769 prefix', () => {
    // Every TikTok id seen so far starts 5769, which is an observation about
    // one seller's orders rather than a format. Requiring it would reject the
    // first order that does not.
    expect(detectSource('123456789012345678')).toBe('tiktok');
  });
});

describe('the file shape', () => {
  it('reads the real header, trailing tab and all', async () => {
    const parsed = await parseFile('tiktok shop.txt', file([tiktok(1), amazon(1)]));

    expect(parsed.format).toBe('tracking');
    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    // The ninth, nameless column Amazon's trailing tab creates is dropped.
    // Papaparse also reports `TooFewFields` for every row because of it; the
    // rows themselves parse perfectly, so those errors are not read.
    expect(parsed.headers).not.toContain('');
  });

  it('reads every column into the right place', async () => {
    const parsed = await parseFile('x.txt', file([
      amazon(1, { shipDate: '2026-10-06', shipMethod: 'PAQ 48' }),
    ]));

    expect(parsed.rows[0]).toMatchObject({
      order_id: '404-0000000-0000001',
      shipping_code: 'PKA6TP9800000000000001X',
      shipped_at: '2026-10-06',
      carrier_code: 'Correos',
      product_code: 'PAQ 48',
    });
  });

  it('is told apart from the full export by its carrier column', () => {
    expect(formatOf(['order_id', 'shipping_code', 'carrier_code', 'shipped_at'])).toBe('tracking');
    // A full export has customer details and no carrier.
    expect(formatOf(['order_id', 'customer_name', 'phone', 'shipping_code'])).toBe('full');
  });

  it('asks a tracking file only for what a tracking file has', async () => {
    // Demanding a phone column of one of these would reject every real file
    // the operator has.
    const parsed = await parseFile('x.txt', file([tiktok(1)]));
    expect(parsed.missingColumns).toEqual([]);
  });

  it('still reports what a full export is missing', async () => {
    const csv = Buffer.from('order_id,customer_name,phone\nA1,Ana,600111222\n', 'utf8');
    const parsed = await parseFile('full.csv', csv);

    expect(parsed.format).toBe('full');
    expect(parsed.missingColumns).toContain('address');
  });
});

describe('the preview', () => {
  async function preview(rows: Row[], known: string[] = []) {
    const parsed = await parseFile('x.txt', file(rows));
    return buildPreview(parsed.rows, new Set(known), parsed.format);
  }

  it('badges each row with its own marketplace', async () => {
    const { rows, summary } = await preview([tiktok(1), tiktok(2), amazon(1)]);

    expect(rows.map((r) => r.source)).toEqual(['tiktok', 'tiktok', 'amazon']);
    // "2 TikTok · 1 Amazon"
    expect(summary.bySource).toEqual([
      { source: 'tiktok', label: 'TikTok', count: 2 },
      { source: 'amazon', label: 'Amazon', count: 1 },
    ]);
  });

  it('accepts a mixed file', async () => {
    const { rows, summary } = await preview([amazon(1), tiktok(1)]);
    expect(summary.new).toBe(2);
    expect(rows.every((r) => r.status === 'new')).toBe(true);
  });

  it('does not treat a missing phone as an error', async () => {
    // The whole file has no phone column. Judging these rows on one would
    // paint all eighty red and make the preview worthless.
    const { rows, summary } = await preview([tiktok(1), tiktok(2), tiktok(3)]);

    expect(summary.needsYou).toBe(0);
    expect(rows.every((r) => r.error === null)).toBe(true);
  });

  it('refuses an order id it cannot place', async () => {
    const { rows } = await preview([{ orderId: 'ORD-77', tracking: 'PK1' }]);

    expect(rows[0].status).toBe('needs_you');
    expect(rows[0].error).toBe("Can't tell whether this is a TikTok or an Amazon order");
  });

  it('refuses an order id Excel has destroyed, and says what to do', async () => {
    const { rows } = await preview([{ orderId: '5.76962E+17', tracking: 'PK2' }]);

    expect(rows[0].status).toBe('needs_you');
    expect(rows[0].error).toContain('Excel');
    expect(rows[0].error).toContain('Export the file again');
  });

  it('skips Correos Express, which is a different company', async () => {
    const { rows, summary } = await preview([
      tiktok(1, { carrierCode: 'Correos Express' }),
      tiktok(2, { carrierCode: 'Correos' }),
    ]);

    expect(rows[0].status).toBe('needs_you');
    expect(rows[0].error).toContain('Not Correos');
    expect(rows[0].error).toContain('Correos Express');
    expect(rows[1].status).toBe('new');
    expect(summary.notCorreos).toBe(1);
  });

  it.each(['SEUR', 'MRW', 'GLS', 'DHL'])('skips %s', async (carrier) => {
    const { rows } = await preview([tiktok(1, { carrierCode: carrier })]);
    expect(rows[0].error).toContain('Not Correos');
  });

  it('reads carrier-name when the code says Other', async () => {
    const { rows } = await preview([
      tiktok(1, { carrierCode: 'Other', carrierName: 'Correos' }),
      tiktok(2, { carrierCode: 'Other', carrierName: 'Correos Express' }),
    ]);

    expect(rows[0].status).toBe('new');
    expect(rows[1].error).toContain('Not Correos');
  });

  it('treats a tracking number repeated in one file as the same parcel', async () => {
    // Amazon writes one row per ITEM, so a two-item order is two rows with one
    // tracking number. Inside a file that is normal, not a duplicate to warn
    // about — but the second row must not create a second parcel either.
    const { rows, summary } = await preview([
      amazon(1, { itemId: '111' }),
      amazon(1, { itemId: '222' }),
    ]);

    expect(rows[0].status).toBe('new');
    expect(rows[1].status).toBe('duplicate');
    expect(summary.new).toBe(1);
  });

  it('calls a re-upload all duplicates', async () => {
    const { summary } = await preview(
      [tiktok(1), tiktok(2)],
      ['PKA6TP9800000000000011X', 'PKA6TP9800000000000012X'],
    );

    expect(summary.duplicate).toBe(2);
    expect(summary.new).toBe(0);
  });

  it('records the ship date as a date', async () => {
    const { rows } = await preview([tiktok(1, { shipDate: '2026-10-06' })]);
    expect(rows[0].shippedAt?.toISOString().slice(0, 10)).toBe('2026-10-06');
  });

  it('marks every marketplace row prepaid', async () => {
    // These files say nothing about payment, and a marketplace has already
    // taken the money.
    const { rows } = await preview([tiktok(1), amazon(1)]);
    expect(rows.every((r) => r.paymentMethod === 'prepaid')).toBe(true);
  });
});

describe('the service', () => {
  it.each([
    ['PAQ PREMIUM', 'PAQ PREMIUM'],
    ['PAQ ESTÁNDAR', 'PAQ ESTÁNDAR'],
    ['PAQ ESTANDAR', 'PAQ ESTÁNDAR'],
    ['paq estandar', 'PAQ ESTÁNDAR'],
    ['PAQ 48', 'PAQ 48'],
    ['  paq  premium  ', 'PAQ PREMIUM'],
  ])('maps %j to %s', (input, code) => {
    expect(productCodeOf(input)).toEqual({ code, guessed: false });
  });

  it('falls back to the standard service and says it guessed', async () => {
    // The product code decides how many days the office holds the parcel, so a
    // wrong guess moves a real deadline. It is flagged rather than silent.
    expect(productCodeOf('PAQ SOMETHING')).toEqual({ code: 'PAQ ESTÁNDAR', guessed: true });
    expect(productCodeOf('')).toEqual({ code: 'PAQ ESTÁNDAR', guessed: true });
  });

  it('flags the guess on the preview row', async () => {
    const parsed = await parseFile('x.txt', file([tiktok(1, { shipMethod: 'MYSTERY' })]));
    const { rows } = buildPreview(parsed.rows, new Set(), parsed.format);

    expect(rows[0].serviceGuessed).toBe(true);
    expect(rows[0].productCode).toBe('PAQ ESTÁNDAR');
  });
});

describe('isCorreosCarrier', () => {
  it('says yes to Correos and no to Correos Express', () => {
    expect(isCorreosCarrier('Correos', '')).toBe(true);
    expect(isCorreosCarrier('correos', '')).toBe(true);
    expect(isCorreosCarrier('Correos Express', '')).toBe(false);
    expect(isCorreosCarrier('CORREOS EXPRESS', '')).toBe(false);
    expect(isCorreosCarrier('correosexpress', '')).toBe(false);
  });

  it('says no to nothing at all', () => {
    expect(isCorreosCarrier('', '')).toBe(false);
    expect(isCorreosCarrier(undefined, undefined)).toBe(false);
  });
});

/* ========================================================================== */

describe('writing the import', () => {
  async function commit(rows: Row[], filename = 'x.txt') {
    const parsed = await parseFile(filename, file(rows));
    const { rows: preview } = buildPreview(parsed.rows, new Set(), parsed.format);

    const [store] = await getDb().insert(stores).values({
      key: 'tiktok-es', name: 'TikTok Shop ES', platform: 'tiktok', ingest: 'manual',
    }).onConflictDoUpdate({ target: stores.key, set: { active: true } })
      .returning({ key: stores.key });

    // `uploaded_by` is a uuid foreign key, so the test needs a real user
    // rather than a placeholder.
    const [user] = await getDb().insert(users).values({
      email: `op-${Date.now()}@example.com`, name: 'Op', passwordHash: 'x',
    }).returning({ id: users.id });

    return commitImport({
      storeKey: store.key, filename, userId: user.id, rows: preview, fixes: {},
    });
  }

  it('creates the Amazon shop the first time an Amazon order turns up', async () => {
    await commit([amazon(1)]);

    const [shop] = await getDb().select().from(stores).where(eq(stores.key, 'amazon-es'));
    expect(shop).toBeDefined();
    expect(shop.name).toBe('Amazon ES');
    expect(shop.platform).toBe('amazon');
    expect(shop.ingest).toBe('manual');
  });

  it('sends each row of a mixed file to its own shop', async () => {
    await commit([tiktok(1), amazon(1)]);

    const rows = await getDb().select({
      code: shipments.shippingCode,
      platform: stores.platform,
    }).from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .innerJoin(stores, eq(stores.id, orders.storeId));

    const byPlatform = new Map(rows.map((r) => [r.platform, r.code]));
    expect(byPlatform.get('tiktok')).toBe('PKA6TP9800000000000011X');
    expect(byPlatform.get('amazon')).toBe('PKA6TP9800000000000001X');
  });

  it('stores the ship date on the shipment', async () => {
    await commit([tiktok(1, { shipDate: '2026-10-06' })]);

    const [row] = await getDb().select().from(shipments);
    expect(row.shippedAt?.toISOString().slice(0, 10)).toBe('2026-10-06');
  });

  it('leaves the order date empty rather than copying the ship date', async () => {
    await commit([amazon(1, { shipDate: '2026-10-06' })]);

    const [row] = await getDb().select().from(orders);
    // These files have no order date. Writing the ship date here made the two
    // columns on the Parcels screen say the same thing while claiming the
    // order was placed the day it was posted.
    expect(row.placedAt).toBeNull();
  });

  it('stores no name, and the screens label it', async () => {
    await commit([amazon(1)]);

    const [row] = await getDb().select().from(orders);
    expect(row.customerName).toBe('');
    // "Unknown customer" in the column is what leaked into the Spanish
    // message as "Hola Unknown".
    expect(customerLabel({ ...row, platform: 'amazon' })).toBe('Amazon order 404-…');
  });

  it('does not write a row the preview refused', async () => {
    const result = await commit([
      { orderId: 'ORD-9', tracking: 'PKBAD1X' },
      tiktok(1),
    ]);

    expect(result.created).toBe(1);
    const rows = await getDb().select({ code: shipments.shippingCode }).from(shipments);
    expect(rows.map((r) => r.code)).toEqual(['PKA6TP9800000000000011X']);
  });

  it('does not put a missing phone on the error report', async () => {
    const result = await commit([tiktok(1), tiktok(2)]);

    expect(result.created).toBe(2);
    // Eighty rows with no phone would otherwise bury the ones genuinely wrong.
    const [batch] = await getDb().select().from(importBatches);
    expect(batch.rowsError).toBe(0);
  });

  it('counts per marketplace for the ticker line', async () => {
    const result = await commit([tiktok(1), tiktok(2), amazon(1)]);

    expect(result.bySource).toEqual([
      { label: 'TikTok orders', count: 2 },
      { label: 'Amazon orders', count: 1 },
    ]);
  });
});

describe('the customer label', () => {
  it('names the marketplace when there is no name', () => {
    expect(customerLabel({ customerName: '', orderNumber: '576900000000000001', platform: 'tiktok' }))
      .toBe('TikTok order 5769…');
    expect(customerLabel({ customerName: '', orderNumber: '404-0000000-0000001', platform: 'amazon' }))
      .toBe('Amazon order 404-…');
  });

  it('uses a real name when there is one', () => {
    expect(customerLabel({ customerName: 'Ana Ruiz', orderNumber: 'X', platform: 'tiktok' }))
      .toBe('Ana Ruiz');
  });

  it('falls back honestly for anything else', () => {
    expect(customerLabel({ customerName: '', orderNumber: 'X', platform: 'shopify' }))
      .toBe('Unknown customer');
  });
});
