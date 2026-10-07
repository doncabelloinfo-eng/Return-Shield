import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { stores } from '@/db/schema';
import {
  SHOPIFY_API_VERSION_DEFAULT, shopifyApiVersion, adminApiUrl,
} from '@/lib/carriers/shopify/api';
import { shopifyBackfill } from '@/jobs/definitions';
import { TestClock, resetClock } from '@/lib/clock';
import { resetDb, closeDb } from './helpers/db';

/**
 * Which Shopify Admin API version the backfill calls.
 *
 * This is tested because of how it fails, which is silently. Shopify supports
 * each quarterly version for a year and then does NOT reject a stale one — it
 * serves the oldest version it still supports instead. So the app sat on
 * `2024-10` long after that version was retired, calling whatever floor
 * Shopify had moved to that quarter, with field names and behaviour shifting
 * underneath it and nothing in any log to say so.
 *
 * A version that is merely wrong is invisible. A version that is in one place
 * and asserted is not.
 */

const KEY = 'versiontest';
const DOMAIN = 'version-test.myshopify.com';
const TOKEN_VAR = 'SHOPIFY_VERSIONTEST_ACCESS_TOKEN';

let clock: TestClock;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-06T10:00:00+02:00');
  clock.install();
  delete process.env.SHOPIFY_API_VERSION;
  delete process.env[TOKEN_VAR];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetClock();
  delete process.env.SHOPIFY_API_VERSION;
  delete process.env[TOKEN_VAR];
});

afterAll(async () => { await closeDb(); });

describe('the version constant', () => {
  it('defaults to 2026-10', () => {
    expect(SHOPIFY_API_VERSION_DEFAULT).toBe('2026-10');
    expect(shopifyApiVersion()).toBe('2026-10');
  });

  it('is overridable with SHOPIFY_API_VERSION', () => {
    process.env.SHOPIFY_API_VERSION = '2025-04';
    expect(shopifyApiVersion()).toBe('2025-04');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
  ])('falls back to the default when the variable is %j (%s)', (value) => {
    // `??` would hand this straight through and produce `/admin/api//orders.json`.
    process.env.SHOPIFY_API_VERSION = value;
    expect(shopifyApiVersion()).toBe(SHOPIFY_API_VERSION_DEFAULT);
  });

  it('trims a value pasted with whitespace', () => {
    process.env.SHOPIFY_API_VERSION = ' 2025-07\n';
    expect(shopifyApiVersion()).toBe('2025-07');
  });

  it('is the only place a version is written down', async () => {
    // The bug was a version spelled out inline at a call site. A second inline
    // copy is how it comes back, so no other source file may contain one.
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      'grep -rnE "admin/api/20[0-9]{2}-[0-9]{2}" --include=*.ts --include=*.tsx '
      + 'app lib jobs db components || true',
      { encoding: 'utf8' },
    ).trim();

    expect(hits).toBe('');
  });
});

describe('adminApiUrl', () => {
  it('builds a versioned Admin API URL', () => {
    expect(adminApiUrl(DOMAIN, 'orders.json')).toBe(
      `https://${DOMAIN}/admin/api/2026-10/orders.json`,
    );
  });

  it('encodes the query string', () => {
    const url = adminApiUrl(DOMAIN, 'orders.json', {
      status: 'any',
      updated_at_min: '2026-10-04T08:00:00.000Z',
    });

    // The timestamp has colons in it, which must not arrive raw.
    expect(url).toContain('updated_at_min=2026-10-04T08%3A00%3A00.000Z');
    expect(url).toContain('status=any');
  });

  it('tolerates a leading slash on the path', () => {
    expect(adminApiUrl(DOMAIN, '/orders.json')).toBe(
      `https://${DOMAIN}/admin/api/2026-10/orders.json`,
    );
  });
});

describe('the backfill', () => {
  async function addStore(): Promise<void> {
    await getDb().insert(stores).values({
      key: KEY, name: 'Version Test', platform: 'shopify', ingest: 'auto', shopDomain: DOMAIN,
    });
  }

  /** Records the URLs the backfill asks for, and answers with no orders. */
  function recordFetch(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ orders: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return urls;
  }

  it('calls the default version, not a retired one', async () => {
    await addStore();
    process.env[TOKEN_VAR] = 'a-token';
    const urls = recordFetch();

    await shopifyBackfill();

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/admin/api/2026-10/orders.json');
    // The version this was pinned to for a year.
    expect(urls[0]).not.toContain('2024-10');
  });

  it('honours SHOPIFY_API_VERSION', async () => {
    await addStore();
    process.env[TOKEN_VAR] = 'a-token';
    process.env.SHOPIFY_API_VERSION = '2025-10';
    const urls = recordFetch();

    await shopifyBackfill();

    expect(urls[0]).toContain('/admin/api/2025-10/orders.json');
  });

  it('still asks for shipped orders from the last two days', async () => {
    // The version change rebuilt this URL from a template string into
    // URLSearchParams, so the parameters are worth re-checking.
    await addStore();
    process.env[TOKEN_VAR] = 'a-token';
    const urls = recordFetch();

    await shopifyBackfill();

    const url = new URL(urls[0]);
    expect(url.searchParams.get('status')).toBe('any');
    /*
     * `any`, not `shipped`. A partially fulfilled order is `partial`, and its
     * posted parcel is as real as any other — `shipped` left those out.
     */
    expect(url.searchParams.get('fulfillment_status')).toBe('any');
    // 250, Shopify's own ceiling. It asked for 100 and read one page, which at
    // a thousand parcels a day was a fraction of two days of orders.
    expect(url.searchParams.get('limit')).toBe('250');
    // Two days before the test clock, to the millisecond, as an ISO string.
    expect(url.searchParams.get('updated_at_min')).toBe('2026-10-04T08:00:00.000Z');
  });

  it('skips a store with no token rather than calling Shopify', async () => {
    await addStore();
    const urls = recordFetch();

    const result = await shopifyBackfill();

    expect(urls).toEqual([]);
    expect(result.detail).toMatchObject({ skipped: [KEY] });
  });

  it('leaves an inactive store alone', async () => {
    await addStore();
    process.env[TOKEN_VAR] = 'a-token';
    await getDb().update(stores).set({ active: false }).where(eq(stores.key, KEY));
    const urls = recordFetch();

    await shopifyBackfill();

    expect(urls).toEqual([]);
  });
});
