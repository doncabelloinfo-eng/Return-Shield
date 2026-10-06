import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, envOr, envSet, envNumber, envList } from '@/lib/env';
import { CorreosTokenProvider, clearTokenCache } from '@/lib/carriers/correos/token';
import { TrackpubClient } from '@/lib/carriers/correos/trackpub';
import { storeEnv } from '@/lib/carriers/shopify/verify';

/**
 * Empty means unset.
 *
 * `process.env.X ?? fallback` reads as "use the fallback when X is not
 * configured" and does not do that: `??` fires on undefined, and a variable
 * added through a hosting dashboard with the value left blank is the empty
 * string. Vercel makes that a two-click mistake.
 *
 * It cost a day in production. `CORREOS_TRACKPUB_BASE_URL` was added with no
 * value, the base URL became `''`, every lookup fetched the bare path as a
 * relative URL, and the answer was "Failed to parse URL from /search/PK…" —
 * which names no variable and reads like a bug in our code.
 */

const TOUCHED = [
  'CORREOS_TRACKPUB_BASE_URL', 'CORREOS_TOKEN_URL', 'CORREOS_OAUTH_SCOPE',
  'CORREOS_OAUTH_RESPONSE_FIELD', 'CORREOS_JWT',
  'CORREOS_OAUTH_CLIENT_ID', 'CORREOS_OAUTH_CLIENT_SECRET',
  'CORREOS_CLIENT_ID', 'CORREOS_CLIENT_SECRET',
  'RS_TEST_VALUE', 'SHOPIFY_BLANK_STORE_WEBHOOK_SECRET',
];

// The token cache is one per instance and parked on globalThis, which is right
// in production — a serverless instance should mint one token and share it —
// and means a provider built in one test answers from another test's token.
beforeEach(() => { clearTokenCache(); for (const k of TOUCHED) delete process.env[k]; });
afterEach(() => { clearTokenCache(); for (const k of TOUCHED) delete process.env[k]; });

describe('env()', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'spaces'],
    ['\n', 'a newline'],
    ['\t ', 'a tab'],
  ])('treats %j (%s) as unset', (value) => {
    process.env.RS_TEST_VALUE = value;
    expect(env('RS_TEST_VALUE')).toBeUndefined();
    expect(envSet('RS_TEST_VALUE')).toBe(false);
    expect(envOr('RS_TEST_VALUE', 'fallback')).toBe('fallback');
  });

  it('is undefined when the variable is absent', () => {
    expect(env('RS_TEST_VALUE')).toBeUndefined();
  });

  it('trims the value it returns', () => {
    // A credential pasted with a trailing newline is a credential that does
    // not match, and nothing in the 401 says so.
    process.env.RS_TEST_VALUE = '  a-secret-value\n';
    expect(env('RS_TEST_VALUE')).toBe('a-secret-value');
  });

  it('keeps whitespace inside the value', () => {
    process.env.RS_TEST_VALUE = 'AP3 LBS RCG';
    expect(env('RS_TEST_VALUE')).toBe('AP3 LBS RCG');
  });
});

describe('envNumber()', () => {
  it('falls back on an empty value rather than reading it as zero', () => {
    // `Number('')` is 0, so `Number(process.env.X ?? 6000)` on a blank value
    // is a batch size of nothing: a sweep that checks no parcels and reports
    // success.
    process.env.RS_TEST_VALUE = '';
    expect(envNumber('RS_TEST_VALUE', 6000)).toBe(6000);
  });

  it.each(['abc', '0', '-5', 'NaN'])('falls back on %j', (value) => {
    process.env.RS_TEST_VALUE = value;
    expect(envNumber('RS_TEST_VALUE', 6000)).toBe(6000);
  });

  it('uses a real number when there is one', () => {
    process.env.RS_TEST_VALUE = ' 250 ';
    expect(envNumber('RS_TEST_VALUE', 6000)).toBe(250);
  });
});

describe('envList()', () => {
  it('is empty for a blank value', () => {
    process.env.RS_TEST_VALUE = '  ';
    expect(envList('RS_TEST_VALUE')).toEqual([]);
  });

  it('trims and drops blanks', () => {
    process.env.RS_TEST_VALUE = ' a, ,b ,';
    expect(envList('RS_TEST_VALUE')).toEqual(['a', 'b']);
  });
});

/* ========================================================================== */

describe('an empty CORREOS_TRACKPUB_BASE_URL', () => {
  it('still produces an absolute URL', async () => {
    process.env.CORREOS_TRACKPUB_BASE_URL = '';

    let seen = '';
    const client = new TrackpubClient({
      clientId: 'gw', clientSecret: 'gw-secret',
      tokenProvider: new CorreosTokenProvider({ staticToken: 'a.b.c' }),
      fetchImpl: (async (url: unknown) => {
        seen = String(url);
        return new Response(JSON.stringify([]), { status: 200 });
      }) as unknown as typeof fetch,
      ratePerSecond: 1000,
    });

    await client.lookup('PQ1');

    // The exact production failure: an empty base made this `/search/PQ1`,
    // which fetch cannot resolve, and the error named no variable.
    expect(seen).toBe('https://api1.correos.es/support/trackpub/api/v2/search/PQ1');
  });

  it('is overridden by a real value', async () => {
    process.env.CORREOS_TRACKPUB_BASE_URL = 'https://api1.correospre.es/support/trackpub/api/v2/';

    let seen = '';
    const client = new TrackpubClient({
      clientId: 'gw', clientSecret: 'gw-secret',
      tokenProvider: new CorreosTokenProvider({ staticToken: 'a.b.c' }),
      fetchImpl: (async (url: unknown) => {
        seen = String(url);
        return new Response(JSON.stringify([]), { status: 200 });
      }) as unknown as typeof fetch,
      ratePerSecond: 1000,
    });

    await client.lookup('PQ1');

    // And the trailing slash is still stripped, rather than producing `//`.
    expect(seen).toBe('https://api1.correospre.es/support/trackpub/api/v2/search/PQ1');
  });
});

describe('empty token variables', () => {
  it('fall back to the production endpoint and the TPB scope', async () => {
    process.env.CORREOS_TOKEN_URL = '';
    process.env.CORREOS_OAUTH_SCOPE = '   ';

    let url = '';
    let body = '';
    const p = new CorreosTokenProvider({
      clientId: 'id', clientSecret: 'secret',
      fetchImpl: (async (u: unknown, init?: RequestInit) => {
        url = String(u);
        body = String(init?.body ?? '');
        return new Response(JSON.stringify({ idToken: 'a.b.c' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await p.get(Date.now());

    expect(url).toBe('https://apioauthcid.correos.es/Api/Authorize/Token');
    expect(new URLSearchParams(body).get('scope')).toBe('TPB');
  });

  it('fall back to idToken when CORREOS_OAUTH_RESPONSE_FIELD is blank', async () => {
    process.env.CORREOS_OAUTH_RESPONSE_FIELD = '  ,  ,';

    const p = new CorreosTokenProvider({
      clientId: 'id', clientSecret: 'secret',
      fetchImpl: (async () => new Response(
        JSON.stringify({ idToken: 'a.b.c', tokenType: 'Bearer', expiresIn: 1800 }),
        { status: 200 },
      )) as unknown as typeof fetch,
    });

    const r = await p.get(Date.now());
    expect(r.ok).toBe(true);
  });

  it('do not make an empty CORREOS_JWT look like a hand-pasted token', async () => {
    process.env.CORREOS_JWT = '';
    process.env.CORREOS_OAUTH_CLIENT_ID = '';
    process.env.CORREOS_OAUTH_CLIENT_SECRET = '';

    // All three blank. Before this, `?? ''` plus `Boolean('')` happened to get
    // the right answer here — but the override would have been used as a token
    // the moment somebody left a stray space in it.
    const p = new CorreosTokenProvider();
    expect(p.configured).toBe(false);
  });

  it('treat a whitespace-only CORREOS_JWT as absent', async () => {
    process.env.CORREOS_JWT = '   ';
    const p = new CorreosTokenProvider();
    expect(p.configured).toBe(false);
  });

  it('trim a credential pasted with a newline', async () => {
    process.env.CORREOS_OAUTH_CLIENT_ID = 'the-id\n';
    process.env.CORREOS_OAUTH_CLIENT_SECRET = ' the-secret ';

    let body = '';
    const p = new CorreosTokenProvider({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        body = String(init?.body ?? '');
        return new Response(JSON.stringify({ idToken: 'a.b.c' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await p.get(Date.now());

    const sent = new URLSearchParams(body);
    expect(sent.get('client_id')).toBe('the-id');
    expect(sent.get('client_secret')).toBe('the-secret');
  });
});

describe('an empty gateway credential', () => {
  it('reads as not configured rather than as a blank header', () => {
    process.env.CORREOS_CLIENT_ID = 'gw';
    process.env.CORREOS_CLIENT_SECRET = '  ';

    const client = new TrackpubClient({
      tokenProvider: new CorreosTokenProvider({ staticToken: 'a.b.c' }),
    });

    expect(client.configured).toBe(false);
  });
});

describe('an empty Shopify secret', () => {
  it('reads as absent, not as the empty string', () => {
    process.env.SHOPIFY_BLANK_STORE_WEBHOOK_SECRET = '';

    // An empty secret would verify an incoming HMAC against the empty string,
    // which is a webhook endpoint that writes to the order table on the
    // strength of a signature anybody can compute.
    expect(storeEnv('blank-store', 'WEBHOOK_SECRET')).toBeUndefined();
  });
});
