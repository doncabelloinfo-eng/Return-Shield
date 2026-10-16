import { customerLabel } from '@/lib/orders/customer-label';
import type { ScanDirection, ScanSource } from './model';

/**
 * What a scan looks like once it has been matched, and the numbers a batch adds
 * up to.
 *
 * NO DATABASE IMPORTS IN THIS FILE, on purpose. The phone draws these rows and
 * counts them on the "Complete this batch?" sheet, and the server counts the
 * same rows the same way when the batch is finished — so the two cannot
 * disagree about what thirteen scanned means. A `getDb` anywhere in here would
 * pull the whole connection layer into the phone's bundle and make that
 * impossible.
 */

/** What the phone and the panel call a matched parcel. */
export interface ScanLabel {
  /** The bold half: the order number, or the marketplace. */
  lead: string;
  /** The muted half: the shop, or the marketplace's own long order id. */
  note: string;
}

export interface ScanItem {
  id: string;
  /** The code exactly as read, normalised. */
  codeAsRead: string;
  /** Its first 15 characters, which is what the list shows in mono. */
  base: string;
  parcelNo: string | null;
  /** The postcode printed inside the Código de Bulto. */
  postalCode: string | null;
  source: ScanSource;
  /** ISO, so it crosses JSON unchanged. */
  scannedAt: string;
  /** How many times this parcel was read in this batch. */
  timesRead: number;
  /** What it matches NOW, or null. Resolved on every read, never frozen. */
  label: ScanLabel | null;
  /**
   * How many parcels share this code's 15-character base.
   *
   * 0 is "not in Return Shield". More than one with no label is a multi-parcel
   * shipment the worker identified only by its EXPEDICIÓN — in Return Shield,
   * but we cannot say which box without the Código de Bulto.
   */
  sharing: number;
  /** The parcel page, while the parcel exists. */
  shipmentId: string | null;
}

export interface Batch {
  id: string;
  direction: ScanDirection;
  startedAt: string;
  finishedAt: string | null;
  items: ScanItem[];
}

/**
 * "#22709 · Don Cabello Profesional", "TikTok order 5769… · TikTok Shop ES",
 * "Amazon · 405-0360895-9964304".
 *
 * Amazon is the odd one out because its order id is the only thing a warehouse
 * can check against a packing slip, so it gets the full id rather than the
 * shortened one the panel's columns use. Nothing here is a customer's name, a
 * phone or an address: the Scanner is never given them, so it cannot show them.
 */
export function scanLabel(m: {
  orderNumber: string;
  storeName: string;
  storePlatform: string;
}): ScanLabel {
  if (m.storePlatform === 'amazon') return { lead: 'Amazon', note: m.orderNumber };
  if (m.storePlatform === 'tiktok') {
    return {
      lead: customerLabel({ customerName: '', orderNumber: m.orderNumber, platform: 'tiktok' }),
      note: m.storeName,
    };
  }
  return { lead: m.orderNumber, note: m.storeName };
}

export const NOT_FOUND_NOTE = 'Not in Return Shield';

/** What an unmatched row says: nothing found, or more than one candidate. */
export function unmatchedNote(sharing: number): string {
  if (sharing > 1) return `${sharing} parcels with this number`;
  return NOT_FOUND_NOTE;
}

/** True when this row is a parcel Return Shield knows, named or not. */
export function isInReturnShield(item: ScanItem): boolean {
  return item.label !== null || item.sharing > 0;
}

export interface BatchSummary {
  scanned: number;
  found: number;
  notFound: number;
  typed: number;
  scannedTwice: number;
  /** Rows the worker should look at before the pile leaves: code and why. */
  needsALook: { base: string; note: string }[];
}

/**
 * The numbers on images 8 and 9, counted FROM THE ROWS.
 *
 * Not from a `count(*)` per condition, which is how a summary comes to say
 * thirteen over a list of twelve. `scanned` is the number of rows; every other
 * number is those same rows filtered, so `found + notFound === scanned` holds
 * by construction rather than by agreement.
 *
 * A code whose base is shared by several parcels counts as FOUND. It IS in
 * Return Shield — we simply cannot say which box without the Código de Bulto —
 * so calling it "not found" would send somebody looking for a missing order.
 * It appears under "Needs a look" with its own words instead.
 */
export function summarise(items: ScanItem[]): BatchSummary {
  const missing = items.filter((i) => !isInReturnShield(i));
  const ambiguous = items.filter((i) => i.label === null && i.sharing > 1);

  return {
    scanned: items.length,
    found: items.length - missing.length,
    notFound: missing.length,
    typed: items.filter((i) => i.source === 'typed').length,
    scannedTwice: items.filter((i) => i.timesRead > 1).length,
    needsALook: [...missing, ...ambiguous].map((i) => ({
      base: i.base,
      note: unmatchedNote(i.sharing),
    })),
  };
}
