import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { normalisePhone, type PhoneResult } from './phone';

/**
 * Reading a TikTok export. CSV or XLSX, both messy, both from a system nobody
 * here controls.
 *
 * Nothing is written to the database from this file. It produces a preview an
 * operator looks at and confirms — which is the only reason it is safe to be
 * this liberal about what it accepts.
 */

export const REQUIRED_COLUMNS = [
  'order_id', 'customer_name', 'phone', 'address', 'city',
  'postal_code', 'shipping_code', 'order_value', 'payment_method', 'shipped_at',
] as const;

export const OPTIONAL_COLUMNS = ['product_code', 'email', 'province'] as const;

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
}

export async function parseFile(filename: string, bytes: Buffer): Promise<ParsedFile> {
  const isExcel = /\.xlsx?$/i.test(filename);
  const { headers, rows } = isExcel ? await parseXlsx(bytes) : parseCsv(bytes);

  const canonical = headers.map(canonicalHeader);
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !canonical.includes(c));

  const mapped = rows.map((row) => {
    const out: RawRow = {};
    headers.forEach((h, i) => {
      const key = canonical[i];
      const value = row[h];
      if (key && value !== undefined && value !== null) out[key] = String(value).trim();
    });
    return out;
  });

  return { headers, rows: mapped, missingColumns };
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

/* -------------------------------------------------------------------------- */

export type RowStatus = 'new' | 'duplicate' | 'fixed' | 'needs_you';

export interface PreviewRow {
  /** Line number in the file the operator is looking at. */
  n: number;
  orderId: string;
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
}

/**
 * Turn raw rows into the preview. Deduped by shipping code, so the same file
 * can be dropped twice — which is exactly what happens when somebody is not
 * sure whether the first upload worked.
 */
export function buildPreview(
  rows: readonly RawRow[],
  knownShippingCodes: ReadonlySet<string>,
): { rows: PreviewRow[]; summary: PreviewSummary } {
  const seen = new Set<string>();
  const out: PreviewRow[] = [];

  rows.forEach((r, i) => {
    const shippingCode = (r.shipping_code ?? '').trim().toUpperCase();
    const phone = normalisePhone(r.phone);

    const duplicate = shippingCode !== '' && (knownShippingCodes.has(shippingCode) || seen.has(shippingCode));
    if (shippingCode) seen.add(shippingCode);

    let status: RowStatus;
    let error: string | null = null;

    if (!shippingCode) {
      status = 'needs_you';
      error = 'No tracking code — nothing to follow';
    } else if (duplicate) {
      status = 'duplicate';
    } else if (phone.status === 'ok') {
      status = phone.fixes.length ? 'fixed' : 'new';
    } else {
      status = 'needs_you';
      error = phone.error;
    }

    out.push({
      n: i + 2, // +1 for the header row, +1 because people count from one
      orderId: (r.order_id ?? '').trim(),
      customerName: (r.customer_name ?? '').trim(),
      phone,
      address: (r.address ?? '').trim(),
      city: (r.city ?? '').trim(),
      postalCode: (r.postal_code ?? '').trim(),
      shippingCode,
      valueCents: parseMoneyCents(r.order_value),
      paymentMethod: parsePayment(r.payment_method),
      productCode: (r.product_code ?? '').trim() || null,
      email: (r.email ?? '').trim() || null,
      shippedAt: parseDate(r.shipped_at),
      status,
      error,
    });
  });

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
