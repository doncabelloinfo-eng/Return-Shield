import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Shopify signs every webhook. We check every one, on the raw bytes, before
 * anything else looks at the body.
 *
 * Parsing first and verifying later would mean an attacker's JSON gets parsed;
 * comparing with `===` would leak the signature a byte at a time. Both are
 * easy to get wrong and neither is visible in testing, so this is the only
 * place in the codebase that is allowed to decide a webhook is genuine.
 */
export function verifyShopifyHmac(rawBody: Buffer | string, headerHmac: string | null, secret: string): boolean {
  if (!headerHmac || !secret) return false;

  const digest = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(headerHmac, 'base64');
  } catch {
    return false;
  }

  return provided.length === digest.length && timingSafeEqual(provided, digest);
}

/** The per-store secret. Store key `main-store` reads SHOPIFY_MAIN_STORE_*. */
export function storeEnv(storeKey: string, suffix: 'WEBHOOK_SECRET' | 'ACCESS_TOKEN' | 'SHOP_DOMAIN'): string | undefined {
  const key = `SHOPIFY_${storeKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;
  // `env`, so a key added with no value reads as absent. An empty webhook
  // secret would otherwise verify an HMAC against the empty string, and an
  // empty access token would have the backfill authenticate with nothing and
  // report the store as unreachable rather than as unconfigured.
  return env(key);
}
