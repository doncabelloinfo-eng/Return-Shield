/**
 * The Correos label, as the warehouse reads it.
 *
 * Two numbers are printed on every return label, and the warehouse can give us
 * either one:
 *
 *   Código de Bulto  PKA6TP980010152 01 08320 G   (23 characters)
 *                    └ 15-char base ┘ └┘ └───┘ └ check letter
 *                                     parcel postal
 *                                     no.    code
 *   EXPEDICIÓN       PKA6TP980010152 E            (16: the same base, its own letter)
 *
 * The parse rules come from the operator's own scanner component, which was
 * checked against 61 real labels from Amazon, Shopify and TikTok Shop. They are
 * here rather than in that component so the phone, the API that stores a scan
 * and the panel that matches one all read a code the same way — a second copy
 * of a regular expression is a second answer to "is this code valid".
 *
 * THE 15-CHARACTER BASE IS THE LINK. It is what both printed numbers have in
 * common, and `shipments.shipping_code` holds whichever of the two its source
 * happened to give us: Shopify's fulfilment carries the expedición, the
 * marketplace files sometimes carry the bulto. So a scan is matched on the
 * base, and the full code only decides between parcels of one shipment.
 */

/** Código de Bulto: 15-char base, 2-digit parcel no., 5-digit postal code, check letter. */
const BULTO_RE = /^([A-Z0-9]{15})(\d{2})(\d{5})([A-Z])$/;
/** EXPEDICIÓN: the same 15-char base, with or without its own check letter. */
const EXPEDICION_RE = /^([A-Z0-9]{15})([A-Z])?$/;

/** What the two numbers share, and what everything is matched on. */
export const CODE_BASE_LENGTH = 15;

export type CodeKind = 'bulto' | 'expedicion' | 'base';

export interface CorreosCode {
  /** The code as read or typed, normalised. This is what gets stored. */
  raw: string;
  /** The first 15 characters. The link to a parcel. */
  base: string;
  /** "01" — only the Código de Bulto has one. */
  parcelNo: string | null;
  /** "08320" — the destination postcode, printed inside the bulto code. */
  postalCode: string | null;
  checkLetter: string | null;
  kind: CodeKind;
}

/**
 * Uppercase, and nothing but A–Z and 0–9.
 *
 * A warehouse phone types with autocapitalise half on and a scanner sometimes
 * reads a trailing space, so "pka6tp980010152 e" and "PKA6TP980010152E" have to
 * be the same code. Everything stored, compared or matched goes through here
 * first.
 */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The 15-character base of a code, or '' if there is not even that much. */
export function baseOf(input: string): string {
  const code = normaliseCode(input);
  return code.length >= CODE_BASE_LENGTH ? code.slice(0, CODE_BASE_LENGTH) : '';
}

/**
 * A Correos code, or null for anything that is not one.
 *
 * Null is the honest answer for junk: the alternative is storing a scan of the
 * sender's barcode, or of the box itself, as if it were a parcel.
 */
export function parseCorreosCode(input: string): CorreosCode | null {
  const raw = normaliseCode(input);

  const bulto = BULTO_RE.exec(raw);
  if (bulto) {
    return {
      raw,
      base: bulto[1],
      parcelNo: bulto[2],
      postalCode: bulto[3],
      checkLetter: bulto[4],
      kind: 'bulto',
    };
  }

  const exp = EXPEDICION_RE.exec(raw);
  if (exp) {
    return {
      raw,
      base: exp[1],
      parcelNo: null,
      postalCode: null,
      checkLetter: exp[2] ?? null,
      kind: 'expedicion',
    };
  }

  return null;
}

/**
 * What the "Reads as" panel says about a typed number, in the operator's
 * English.
 *
 * The length is part of it on purpose. A worker who has typed fifteen
 * characters of a sixteen-character number is told so while the keyboard is
 * still open, which is cheaper than a batch with a code nobody can match.
 */
export function readsAs(code: CorreosCode): string {
  if (code.kind === 'bulto') return `${code.raw.length} characters · Código de Bulto`;
  if (code.checkLetter) return `${code.raw.length} characters · EXPEDICIÓN number`;
  return `${code.raw.length} characters · EXPEDICIÓN without its check letter`;
}
