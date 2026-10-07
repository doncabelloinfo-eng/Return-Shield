import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { normalisePhone, type PhoneResult } from './phone';

/**
 * Reading a marketplace export. CSV, TSV, TXT or XLSX, all messy, all from
 * systems nobody here controls.
 *
 * Nothing is written to the database from this file. It produces a preview an
 * operator looks at and confirms — which is the only reason it is safe to be
 * this liberal about what it accepts.
 *
 * TWO FILE SHAPES, and the difference matters.
 *
 * The FULL shape is the one this started with: name, phone, address, value,
 * everything needed to chase a customer directly.
 *
 * The TRACKING shape is what the operator actually exports — Amazon's and
 * TikTok's shipping-confirmation files ("Seguimiento"). Eight columns, no
 * customer details at all: an order id, a tracking number, a ship date, a
 * carrier and a service. A missing phone is therefore NOT an error in one of
 * those, and treating it as one would paint every row red and make the preview
 * useless. Contact for those parcels goes through the marketplace's own chat.
 *
 * Amazon and TikTok export the SAME eight columns, so which marketplace a row
 * came from is worked out per row from the order id. The file name is never
 * proof: one was `Seguimiento_Amazon_07102026_015340.txt` and the other
 * `tiktok shop.txt`, and people rename these.
 */

/** The full export: everything needed to chase a customer directly. */
export const REQUIRED_COLUMNS = [
  'order_id', 'customer_name', 'phone', 'address', 'city',
  'postal_code', 'shipping_code', 'order_value', 'payment_method', 'shipped_at',
] as const;

/**
 * The shipping-confirmation export. No customer details, by design.
 *
 * A carrier column is required but either spelling will do: Amazon fills
 * `carrier-code` and leaves `carrier-name` empty, and uses `carrier-name` when
 * the code is `Other`.
 */
export const TRACKING_REQUIRED_COLUMNS = [
  'order_id', 'shipping_code', 'shipped_at',
] as const;

export const OPTIONAL_COLUMNS = ['product_code', 'email', 'province'] as const;

export type FileFormat = 'full' | 'tracking';

/** Which marketplace one row came from. */
export type RowSource = 'tiktok' | 'amazon' | 'unknown' | 'excel_damaged';

/**
 * TikTok has renamed these columns at least twice. Matching on a normalised
 * header rather than an exact string means the next rename is a one-line
 * change here instead of a support call on a Monday morning.
 */
const HEADER_ALIASES: Record<string, string> = {
  orderid: 'order_id', ordernumber: 'order_id', orderno: 'order_id', pedido: 'order_id',
  customername: 'customer_name', buyername: 'customer_name', recipient: 'customer_name',
  recipientname: 'customer_name', nombre: 'customer_name', cliente: 'customer_name',
  phone: 'phone', phonenumber: 'phone', telephone: 'phone', mobile: 'phone',
  telefono: 'phone', movil: 'phone', recipientphone: 'phone',
  address: 'address', address1: 'address', streetaddress: 'address',
  detailaddress: 'address', direccion: 'address',
  city: 'city', town: 'city', ciudad: 'city', localidad: 'city', poblacion: 'city',
  postalcode: 'postal_code', postcode: 'postal_code', zip: 'postal_code',
  zipcode: 'postal_code', cp: 'postal_code', codigopostal: 'postal_code',
  shippingcode: 'shipping_code', trackingnumber: 'shipping_code', tracking: 'shipping_code',
  trackingno: 'shipping_code', localizador: 'shipping_code',
  ordervalue: 'order_value', total: 'order_value', totalamount: 'order_value',
  amount: 'order_value', importe: 'order_value', valor: 'order_value',
  paymentmethod: 'payment_method', payment: 'payment_method', pago: 'payment_method',
  shippedat: 'shipped_at', shipdate: 'shipped_at', shippingtime: 'shipped_at',
  fechaenvio: 'shipped_at', createdtime: 'shipped_at',
  productcode: 'product_code', service: 'product_code', servicio: 'product_code',
  shipmethod: 'product_code',
  // The tracking export's own columns.
  carriercode: 'carrier_code', carriername: 'carrier_name',
  orderitemid: 'order_item_id', quantity: 'quantity',
  email: 'email', correo: 'email',
  province: 'province', provincia: 'province', state: 'province',
};

function canonicalHeader(h: string): string {
  const key = h.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[key] ?? key;
}

export type RawRow = Record<string, string>;

export interface ParsedFile {
  headers: string[];
  rows: RawRow[];
  /** Required columns the file simply does not have. */
  missingColumns: string[];
  /** Which shape it turned out to be. Decides what is required of it. */
  format: FileFormat;
}

export async function parseFile(filename: string, bytes: Buffer): Promise<ParsedFile> {
  const isExcel = /\.xlsx?$/i.test(filename);
  const { headers, rows } = isExcel ? await parseXlsx(bytes) : parseCsv(bytes);

  const canonical = headers.map(canonicalHeader);
  const format = formatOf(canonical);

  // What a file must have depends on what it is. Demanding a phone column of a
  // shipping-confirmation export would reject every real file the operator has.
  const missingColumns = format === 'tracking'
    ? trackingMissing(canonical)
    : REQUIRED_COLUMNS.filter((c) => !canonical.includes(c));

  const mapped = rows.map((row) => {
    const out: RawRow = {};
    headers.forEach((h, i) => {
      const key = canonical[i];
      const value = row[h];
      // `key` is empty for the trailing tab Amazon writes after the last
      // header. That ninth, nameless column is skipped here; papaparse also
      // reports `TooFewFields` for every row because of it, and those errors
      // are not read — the rows themselves parse perfectly.
      if (key && value !== undefined && value !== null) out[key] = String(value).trim();
    });
    return out;
  });

  return { headers: headers.filter(Boolean), rows: mapped, missingColumns, format };
}

/**
 * Which shape this is.
 *
 * A carrier column is the giveaway: the full export has never had one, and the
 * shipping-confirmation export always does. Checked alongside a tracking
 * number so a full export that happens to gain a carrier column one day does
 * not get read as the wrong shape.
 */
export function formatOf(canonical: readonly string[]): FileFormat {
  const hasCarrier = canonical.includes('carrier_code') || canonical.includes('carrier_name');
  const hasTracking = canonical.includes('shipping_code');
  const hasCustomer = canonical.includes('customer_name') || canonical.includes('phone');
  return hasCarrier && hasTracking && !hasCustomer ? 'tracking' : 'full';
}

function trackingMissing(canonical: readonly string[]): string[] {
  const missing: string[] = TRACKING_REQUIRED_COLUMNS.filter((c) => !canonical.includes(c));
  if (!canonical.includes('carrier_code') && !canonical.includes('carrier_name')) {
    missing.push('carrier-code');
  }
  return missing;
}

function parseCsv(bytes: Buffer): { headers: string[]; rows: RawRow[] } {
  // TikTok's Spanish exports are UTF-8 with a BOM often enough to matter.
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const result = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    // Semicolons are what a Spanish Excel writes when it saves a CSV.
    delimiter: '',
    transformHeader: (h) => h.trim(),
  });
  return { headers: result.meta.fields ?? [], rows: result.data };
}

async function parseXlsx(bytes: Buffer): Promise<{ headers: string[]; rows: RawRow[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col - 1] = String(cellText(cell.value)).trim();
  });

  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const out: RawRow = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const v = cellText(row.getCell(i + 1).value);
      out[h] = v;
      if (v) any = true;
    });
    if (any) rows.push(out);
  });

  return { headers: headers.filter(Boolean), rows };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return String((v as { result: unknown }).result ?? '');
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
  }
  return String(v);
}

/* ----------------------------------------------------- which marketplace */

/**
 * Amazon or TikTok, from the order id alone.
 *
 * The two files have identical headers, so this is the only reliable
 * difference. Amazon's filled `order-item-id` and `quantity` agree with it,
 * but a TikTok export with those columns populated one day would then be read
 * as Amazon — so they are not used.
 *
 *   Amazon  404-0000000-0000001   3, 7 and 7 digits with dashes
 *   TikTok  576900000000000001    18 plain digits (every one seen starts 5769)
 *
 * The range is 16 to 20 rather than exactly 18: TikTok's ids are an opaque
 * sequence and pinning the length is the kind of assumption that breaks
 * quietly a year later. The `5769` prefix is deliberately NOT required for the
 * same reason — it is an observation about one seller's orders, not a format.
 */
const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const TIKTOK_ORDER_ID = /^\d{16,20}$/;

/**
 * What Excel does to a long number when somebody opens the file and saves it:
 * `576962...` becomes `5.76962E+17` and the original digits are gone for good.
 * Refusing the row is the only honest answer — there is nothing to recover.
 */
const EXCEL_DAMAGED = /^\d(?:\.\d+)?[eE][+-]?\d+$/;

export function detectSource(orderId: string | undefined): RowSource {
  const id = (orderId ?? '').trim();
  if (!id) return 'unknown';
  if (EXCEL_DAMAGED.test(id)) return 'excel_damaged';
  if (AMAZON_ORDER_ID.test(id)) return 'amazon';
  if (TIKTOK_ORDER_ID.test(id)) return 'tiktok';
  return 'unknown';
}

export const SOURCE_LABEL: Record<RowSource, string> = {
  tiktok: 'TikTok',
  amazon: 'Amazon',
  unknown: 'Unknown',
  excel_damaged: 'Damaged by Excel',
};

/** The store key each marketplace's orders go to. */
export const SOURCE_STORE: Record<'tiktok' | 'amazon', { key: string; name: string; platform: 'tiktok' | 'amazon' }> = {
  tiktok: { key: 'tiktok-es', name: 'TikTok Shop ES', platform: 'tiktok' },
  amazon: { key: 'amazon-es', name: 'Amazon ES', platform: 'amazon' },
};

/* --------------------------------------------------------------- carriers */

/**
 * Is this parcel actually ours to track?
 *
 * **Correos Express is a different company.** It is a separate courier with
 * its own tracking numbers and its own API, and a parcel of theirs would sit
 * in this system for ever while the reconcile sweep asked Correos about a code
 * Correos has never heard of. So it is skipped by name, before the looser
 * "contains Correos" test.
 *
 * `carrier-name` is only consulted when the code says `Other`, which is what
 * Amazon does for carriers it has no code for.
 */
export function isCorreosCarrier(code: string | undefined, name: string | undefined): boolean {
  const c = (code ?? '').trim();
  const effective = /^other$/i.test(c) ? (name ?? '').trim() : (c || (name ?? '').trim());
  const flat = effective.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  if (!flat) return false;
  if (/correos\s*express/.test(flat)) return false;
  return /correos/.test(flat);
}

export function carrierNameOf(code: string | undefined, name: string | undefined): string {
  const c = (code ?? '').trim();
  if (/^other$/i.test(c)) return (name ?? '').trim() || 'Other';
  return c || (name ?? '').trim() || 'none given';
}

/* ---------------------------------------------------------------- service */

/** The three Correos services, and the only place their spellings live. */
const SERVICES = ['PAQ PREMIUM', 'PAQ ESTÁNDAR', 'PAQ 48'] as const;

/**
 * `ship-method` to a product code.
 *
 * Matched without accents or case, because the files are inconsistent about
 * "ESTÁNDAR" and "ESTANDAR". Anything unrecognised becomes the standard
 * service AND is flagged, rather than silently: the product code decides how
 * many days the office holds the parcel, so a wrong guess moves a real
 * deadline.
 */
export function productCodeOf(shipMethod: string | undefined): { code: string; guessed: boolean } {
  const flat = (shipMethod ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();

  if (!flat) return { code: 'PAQ ESTÁNDAR', guessed: true };

  for (const service of SERVICES) {
    const target = service.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    if (flat === target) return { code: service, guessed: false };
  }

  return { code: 'PAQ ESTÁNDAR', guessed: true };
}

/* -------------------------------------------------------------------------- */

export type RowStatus = 'new' | 'duplicate' | 'fixed' | 'needs_you';

export interface PreviewRow {
  /** Line number in the file the operator is looking at. */
  n: number;
  orderId: string;
  /** Which marketplace this row's order id says it came from. */
  source: RowSource;
  /** Whether the service had to be guessed. Shown in the preview. */
  serviceGuessed: boolean;
  /** The carrier the file named, for the "Not Correos" message. */
  carrier: string;
  customerName: string;
  phone: PhoneResult;
  address: string;
  city: string;
  postalCode: string;
  shippingCode: string;
  valueCents: number;
  paymentMethod: 'prepaid' | 'cod';
  productCode: string | null;
  email: string | null;
  shippedAt: Date | null;
  status: RowStatus;
  /** What is wrong, when something is. */
  error: string | null;
}

export interface PreviewSummary {
  total: number;
  new: number;
  duplicate: number;
  needsYou: number;
  autofixed: number;
  /** Skipped because the carrier is somebody else's. */
  notCorreos: number;
  /** "82 TikTok · 1 Amazon" — a count per marketplace. */
  bySource: { source: RowSource; label: string; count: number }[];
}

/**
 * Turn raw rows into the preview. Deduped by shipping code, so the same file
 * can be dropped twice — which is exactly what happens when somebody is not
 * sure whether the first upload worked.
 */
export function buildPreview(
  rows: readonly RawRow[],
  knownShippingCodes: ReadonlySet<string>,
  format: FileFormat = 'full',
): { rows: PreviewRow[]; summary: PreviewSummary } {
  const seen = new Set<string>();
  const out: PreviewRow[] = [];
  const tracking = format === 'tracking';

  rows.forEach((r, i) => {
    const shippingCode = (r.shipping_code ?? '').trim().toUpperCase();
    const phone = normalisePhone(r.phone);
    const orderId = (r.order_id ?? '').trim();
    const source = tracking ? detectSource(orderId) : 'unknown';
    const service = productCodeOf(r.product_code);
    const carrier = carrierNameOf(r.carrier_code, r.carrier_name);

    /*
     * A tracking number that repeats inside one file is the same parcel seen
     * again, not a duplicate to warn about: Amazon writes one row per ITEM, so
     * a two-item order is two rows with one tracking number. Within a file
     * that is normal and silent; against the database it is a real duplicate
     * and the operator should see it.
     */
    const repeatedInFile = shippingCode !== '' && seen.has(shippingCode);
    const alreadyHave = shippingCode !== '' && knownShippingCodes.has(shippingCode);
    if (shippingCode) seen.add(shippingCode);

    let status: RowStatus;
    let error: string | null = null;

    if (!shippingCode) {
      status = 'needs_you';
      error = 'No tracking code — nothing to follow';
    } else if (tracking && source === 'excel_damaged') {
      // `5.76962E+17`. The digits are gone and cannot be recovered.
      status = 'needs_you';
      error = `Excel has destroyed this order number ("${orderId}"). `
        + 'Export the file again and do not open it in Excel.';
    } else if (tracking && source === 'unknown') {
      status = 'needs_you';
      error = "Can't tell whether this is a TikTok or an Amazon order";
    } else if (tracking && !isCorreosCarrier(r.carrier_code, r.carrier_name)) {
      // Correos Express is a different company with its own tracking.
      status = 'needs_you';
      error = `Not Correos — the carrier is "${carrier}"`;
    } else if (alreadyHave || repeatedInFile) {
      status = 'duplicate';
    } else if (tracking) {
      /*
       * No phone is EXPECTED here. The shipping-confirmation export carries no
       * customer details at all, so judging these rows on a phone number would
       * paint every single one red and make the preview worthless. Contact for
       * these parcels goes through the marketplace's own chat.
       */
      status = 'new';
    } else if (phone.status === 'ok') {
      status = phone.fixes.length ? 'fixed' : 'new';
    } else {
      status = 'needs_you';
      error = phone.error;
    }

    out.push({
      n: i + 2, // +1 for the header row, +1 because people count from one
      orderId,
      source,
      serviceGuessed: tracking && service.guessed,
      carrier,
      customerName: (r.customer_name ?? '').trim(),
      phone,
      address: (r.address ?? '').trim(),
      city: (r.city ?? '').trim(),
      postalCode: (r.postal_code ?? '').trim(),
      shippingCode,
      valueCents: parseMoneyCents(r.order_value),
      // These files say nothing about payment. Prepaid is the right default:
      // a marketplace has already taken the money.
      paymentMethod: tracking ? 'prepaid' : parsePayment(r.payment_method),
      productCode: tracking ? service.code : ((r.product_code ?? '').trim() || null),
      email: (r.email ?? '').trim() || null,
      shippedAt: parseDate(r.shipped_at),
      status,
      error,
    });
  });

  const counted = out.filter((r) => r.source === 'tiktok' || r.source === 'amazon');
  const bySource = (['tiktok', 'amazon'] as const)
    .map((source) => ({
      source: source as RowSource,
      label: SOURCE_LABEL[source],
      count: counted.filter((r) => r.source === source).length,
    }))
    .filter((c) => c.count > 0);

  return {
    rows: out,
    summary: {
      total: out.length,
      new: out.filter((r) => r.status === 'new' || r.status === 'fixed').length,
      duplicate: out.filter((r) => r.status === 'duplicate').length,
      needsYou: out.filter((r) => r.status === 'needs_you').length,
      // Only numbers that ended up usable. Stripping a space off a landline
      // changed the string but fixed nothing — counting it would put a number
      // in the "fixed automatically" headline that still needs a person.
      autofixed: out.filter((r) => r.status === 'fixed').length,
      notCorreos: out.filter((r) => r.error?.startsWith('Not Correos')).length,
      bySource,
    },
  };
}

/**
 * "1.234,56", "1,234.56", "€42.00", "42" — all of these turn up in the same
 * file. The last separator in the string is the decimal one.
 */
export function parseMoneyCents(input: string | undefined): number {
  if (!input) return 0;
  const s = input.replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalised: string;

  if (lastComma === -1 && lastDot === -1) {
    normalised = s;
  } else if (lastComma > lastDot) {
    normalised = s.replace(/\./g, '').replace(',', '.');
  } else {
    normalised = s.replace(/,/g, '');
  }

  const n = Number.parseFloat(normalised);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Cash on delivery goes by many names, and getting it wrong costs the sale. */
export function parsePayment(input: string | undefined): 'prepaid' | 'cod' {
  const s = (input ?? '').toLowerCase();
  if (/cod|cash|contra ?reembolso|reembolso|contrareembolso|efectivo/.test(s)) return 'cod';
  return 'prepaid';
}

export function parseDate(input: string | undefined): Date | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // dd/mm/yyyy — the Spanish way round, and the one Date.parse gets wrong.
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(trimmed);
  if (dmy) {
    const [, d, m, y, hh = '0', mm = '0'] = dmy;
    return new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm));
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
