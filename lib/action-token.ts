import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The credential for the public /e/{token} page.
 *
 * The token carries no personal data — not the order number, not a phone
 * number, not the customer's name. It is a random id plus a signature, so a
 * link forwarded into a group chat, logged by a proxy or screenshotted leaks
 * nothing at all until it is opened, and what it opens is checked server-side
 * against the shipment's own expiry.
 *
 * Signing rather than storing a bare random string means a forged token is
 * rejected without a database round trip, which is what makes the per-IP rate
 * limit on that route cheap enough to be strict.
 */

const SEPARATOR = '.';

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters');
  }
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** A fresh token for one message about one shipment. */
export function mintActionToken(shipmentId: string): string {
  const nonce = randomBytes(9).toString('base64url');
  const payload = `${shipmentId}${SEPARATOR}${nonce}`;
  return `${payload}${SEPARATOR}${sign(payload)}`;
}

export interface VerifiedToken {
  shipmentId: string;
  nonce: string;
}

/**
 * Check the signature only. Expiry, whether the parcel was delivered, and the
 * rate limit are all checked by the route — this function answers one question
 * and answers it in constant time.
 */
export function verifyActionToken(token: string): VerifiedToken | null {
  const parts = token.split(SEPARATOR);
  if (parts.length !== 3) return null;

  const [shipmentId, nonce, signature] = parts;
  const expected = sign(`${shipmentId}${SEPARATOR}${nonce}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { shipmentId, nonce };
}
