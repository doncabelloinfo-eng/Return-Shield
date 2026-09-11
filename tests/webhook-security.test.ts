import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyShopifyHmac, storeEnv } from '@/lib/carriers/shopify/verify';
import { isCorreos } from '@/lib/carriers/shopify/ingest';
import { mintActionToken, verifyActionToken } from '@/lib/action-token';

const SECRET = 'shpss_a_real_looking_webhook_secret';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
}

/**
 * A webhook endpoint is a door onto the order table. Everything that comes
 * through it is hostile until the signature says otherwise.
 */
describe('Shopify webhook signatures', () => {
  const body = JSON.stringify({ id: 4821, name: 'ORD-4821', total_price: '64.90' });

  it('accepts a genuine signature', () => {
    expect(verifyShopifyHmac(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a forged one', () => {
    expect(verifyShopifyHmac(body, sign(body, 'not-the-secret'), SECRET)).toBe(false);
  });

  it('rejects a body that was tampered with after signing', () => {
    const signature = sign(body);
    const tampered = JSON.stringify({ id: 4821, name: 'ORD-4821', total_price: '6490.00' });
    expect(verifyShopifyHmac(tampered, signature, SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyShopifyHmac(body, null, SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, '', SECRET)).toBe(false);
  });

  it('rejects everything when the secret is not configured', () => {
    // Better to reject every webhook than to accept every webhook.
    expect(verifyShopifyHmac(body, sign(body), '')).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyShopifyHmac(body, 'AAAA', SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, 'not base64 at all !!!', SECRET)).toBe(false);
  });

  it('verifies the exact bytes, not a re-serialised object', () => {
    // Key order and whitespace change the signature. Verifying a re-encoded
    // body would fail on every genuine webhook from a store that pretty-prints.
    const spaced = '{\n  "id": 4821\n}';
    expect(verifyShopifyHmac(spaced, sign(spaced), SECRET)).toBe(true);
  });

  it('builds the per-store env key from the store slug', () => {
    process.env.SHOPIFY_MAIN_STORE_WEBHOOK_SECRET = 'x';
    expect(storeEnv('main-store', 'WEBHOOK_SECRET')).toBe('x');
    expect(storeEnv('main store', 'WEBHOOK_SECRET')).toBe('x');
    delete process.env.SHOPIFY_MAIN_STORE_WEBHOOK_SECRET;
  });
});

describe('spotting a Correos fulfilment', () => {
  it('recognises the carrier by name', () => {
    expect(isCorreos({ tracking_company: 'Correos', tracking_number: 'AB123456789ES' })).toBe(true);
    expect(isCorreos({ tracking_company: 'CORREOS PAQ 48', tracking_number: 'X' })).toBe(true);
  });

  it('recognises it by the tracking URL when the name is blank', () => {
    expect(isCorreos({ tracking_company: '', tracking_url: 'https://www.correos.es/track/AB1' })).toBe(true);
  });

  it('recognises it by the shape of the code', () => {
    expect(isCorreos({ tracking_number: 'PQ7842931055ES' })).toBe(true);
  });

  it('ignores fulfilments from other carriers', () => {
    expect(isCorreos({ tracking_company: 'SEUR', tracking_number: '12345678' })).toBe(false);
    expect(isCorreos({ tracking_company: 'GLS', tracking_number: 'ZXY' })).toBe(false);
    expect(isCorreos({})).toBe(false);
  });
});

/**
 * The public /e/{token} page has no login. The token is the credential, so it
 * has to behave like one.
 */
describe('customer action tokens', () => {
  it('round-trips a token it minted', () => {
    const token = mintActionToken('11111111-2222-3333-4444-555555555555');
    expect(verifyActionToken(token)?.shipmentId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('rejects a token with a tampered shipment id', () => {
    const token = mintActionToken('11111111-2222-3333-4444-555555555555');
    const [, nonce, sig] = token.split('.');
    expect(verifyActionToken(`99999999-2222-3333-4444-555555555555.${nonce}.${sig}`)).toBeNull();
  });

  it('rejects a token with no signature, a short signature, or junk', () => {
    expect(verifyActionToken('abc')).toBeNull();
    expect(verifyActionToken('a.b')).toBeNull();
    expect(verifyActionToken('a.b.c')).toBeNull();
    expect(verifyActionToken('')).toBeNull();
  });

  it('gives a different token every time, so one link is not every link', () => {
    const a = mintActionToken('11111111-2222-3333-4444-555555555555');
    const b = mintActionToken('11111111-2222-3333-4444-555555555555');
    expect(a).not.toBe(b);
  });

  it('carries no personal data — only an id and a signature', () => {
    const token = mintActionToken('11111111-2222-3333-4444-555555555555');
    expect(token).not.toMatch(/Luc|627|ORD-|@/);
  });
});
