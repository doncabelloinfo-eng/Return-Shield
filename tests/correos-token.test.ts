import { describe, it, expect, beforeEach } from 'vitest';
import { CorreosTokenProvider, clearTokenCache, expiryOf } from '@/lib/carriers/correos/token';

/**
 * The token is the thing that makes every trackpub call possible, and the one
 * secret in this system with a thirty-minute life. Three properties matter:
 * it is cached (or we mint one per parcel and get rate limited), it is renewed
 * before it expires rather than after, and it never appears in a log.
 */

const CLIENT = { clientId: 'portal-id', clientSecret: 'portal-secret-value' };

/** A JWT whose payload says it expires at `expSeconds`. Signature is not checked. */
function jwtExpiring(expSeconds: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ exp: expSeconds, sub: 'return-shield' })}.sig`;
}

interface Call { url: string; body: string; headers: Record<string, string> }

/** A token endpoint that answers whatever we tell it to, and records the asking. */
function stubEndpoint(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init?.body ?? ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const inMinutes = (m: number) => Math.floor((NOW + m * 60_000) / 1000);

beforeEach(() => {
  clearTokenCache();
  delete process.env.CORREOS_JWT;
  delete process.env.CORREOS_OAUTH_CLIENT_ID;
  delete process.env.CORREOS_OAUTH_CLIENT_SECRET;
});

describe('asking CorreosID for a token', () => {
  it('posts client_credentials form-encoded, with the scope', async () => {
    const { calls, fetchImpl } = stubEndpoint([{ body: { idToken: jwtExpiring(inMinutes(30)) } }]);
    const p = new CorreosTokenProvider({ ...CLIENT, fetchImpl });

    const r = await p.get(NOW);

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const sent = new URLSearchParams(calls[0].body);
    expect(sent.get('grant_type')).toBe('client_credentials');
    expect(sent.get('client_id')).toBe('portal-id');
    expect(sent.get('client_secret')).toBe('portal-secret-value');
    // TPB is trackpub's application code in CorreosID, confirmed by Correos
    // support and by a working production token. The two open-source SDKs this
    // was built from send `AP3 LBS RCG`, which mints a token perfectly happily
    // and is then refused by trackpub with `401 {"error": "Invalid token."}`.
    expect(sent.get('scope')).toBe('TPB');
    expect(calls[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('defaults to the production token endpoint', async () => {
    const { calls, fetchImpl } = stubEndpoint([{ body: { idToken: jwtExpiring(inMinutes(30)) } }]);
    await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);
    expect(calls[0].url).toBe('https://apioauthcid.correos.es/Api/Authorize/Token');
  });

  it('reads idToken', async () => {
    const token = jwtExpiring(inMinutes(30));
    const { fetchImpl } = stubEndpoint([{ body: { idToken: token, access_token: 'the-wrong-one' } }]);
    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);
    expect(r.ok && r.token).toBe(token);
  });

  it('falls back to access_token when there is no idToken', async () => {
    const token = jwtExpiring(inMinutes(30));
    const { fetchImpl } = stubEndpoint([{ body: { access_token: token } }]);
    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);
    expect(r.ok && r.token).toBe(token);
  });

  it('says what it looked for when the response has neither', async () => {
    const { fetchImpl } = stubEndpoint([{ body: { token: 'surprise', ttl: 1800 } }]);
    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('idToken');
    expect(r.error).toContain('access_token');
    // The field NAMES are diagnostic; the values are never printed.
    expect(r.error).toContain('token, ttl');
    expect(r.error).not.toContain('surprise');
  });

  it('reports a refusal without leaking our own credentials back out', async () => {
    // A token endpoint that echoes the request is not hypothetical, and this is
    // the one error path where a secret could end up in a log.
    const { fetchImpl } = stubEndpoint([{
      status: 401,
      body: { error: 'invalid_client', sent: 'portal-secret-value for portal-id' },
    }]);

    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('401');
    expect(r.error).toContain('invalid_client');
    expect(r.error).not.toContain('portal-secret-value');
    expect(r.error).not.toContain('portal-id');
    expect(r.error).toContain('[redacted]');
  });

  it('says which variables are missing rather than calling with blanks', async () => {
    const { calls, fetchImpl } = stubEndpoint([{ body: {} }]);
    const r = await new CorreosTokenProvider({ fetchImpl }).get(NOW);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('CORREOS_OAUTH_CLIENT_ID');
    expect(calls).toHaveLength(0);
  });

  it('survives a token endpoint that does not return JSON', async () => {
    const { fetchImpl } = stubEndpoint([{ body: '<html>gateway timeout</html>' }]);
    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('did not return JSON');
  });

  it('survives an unreachable token endpoint', async () => {
    const fetchImpl = (async () => { throw new Error('ENOTFOUND apioauthcid.correos.es'); }) as unknown as typeof fetch;
    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('could not reach the token endpoint');
  });
});

describe('caching', () => {
  it('mints once and reuses it', async () => {
    const { calls, fetchImpl } = stubEndpoint([{ body: { idToken: jwtExpiring(inMinutes(30)) } }]);
    const p = new CorreosTokenProvider({ ...CLIENT, fetchImpl });

    const first = await p.get(NOW);
    const second = await p.get(NOW + 60_000);

    expect(calls).toHaveLength(1);
    expect(first.ok && second.ok && first.token === second.token).toBe(true);
    expect(second.ok && second.source).toBe('cache');
  });

  it('renews a minute before expiry, not after', async () => {
    // A token that expires during an in-flight request is a 401 we could have
    // avoided, so the margin is the point of the test.
    const { calls, fetchImpl } = stubEndpoint([
      { body: { idToken: jwtExpiring(inMinutes(30)) } },
      { body: { idToken: jwtExpiring(inMinutes(60)) } },
    ]);
    const p = new CorreosTokenProvider({ ...CLIENT, fetchImpl });

    await p.get(NOW);
    await p.get(NOW + 28.5 * 60_000);   // still inside the margin
    expect(calls).toHaveLength(1);

    await p.get(NOW + 29.5 * 60_000);   // within a minute of expiry
    expect(calls).toHaveLength(2);
  });

  it('collapses concurrent callers onto one request', async () => {
    // The sweep asks for a token per batch. Fifty batches starting at once must
    // not be fifty token requests.
    let resolveIt: ((r: Response) => void) | null = null;
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return new Promise<Response>((resolve) => { resolveIt = resolve; });
    }) as unknown as typeof fetch;

    const p = new CorreosTokenProvider({ ...CLIENT, fetchImpl });
    const all = Promise.all([p.get(NOW), p.get(NOW), p.get(NOW), p.get(NOW)]);

    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);

    resolveIt!(new Response(JSON.stringify({ idToken: jwtExpiring(inMinutes(30)) }), { status: 200 }));
    const results = await all;
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('mints a fresh one after invalidate — the 401 path', async () => {
    const a = jwtExpiring(inMinutes(30));
    const b = jwtExpiring(inMinutes(60));
    const { calls, fetchImpl } = stubEndpoint([{ body: { idToken: a } }, { body: { idToken: b } }]);
    const p = new CorreosTokenProvider({ ...CLIENT, fetchImpl });

    const first = await p.get(NOW);
    p.invalidate();
    const second = await p.get(NOW);

    expect(calls).toHaveLength(2);
    expect(first.ok && first.token).toBe(a);
    expect(second.ok && second.token).toBe(b);
  });

  it('does not re-fetch on every call when the token is already expired', async () => {
    // An `exp` in the past would put the renewal deadline in the past too, and
    // every single call would mint a new token.
    const { calls, fetchImpl } = stubEndpoint([{ body: { idToken: jwtExpiring(inMinutes(-10)) } }]);
    const p = new CorreosTokenProvider({ ...CLIENT, fetchImpl });

    await p.get(NOW);
    await p.get(NOW + 500);
    expect(calls).toHaveLength(1);
  });

  it('assumes 25 minutes when the JWT has no readable exp', async () => {
    const { fetchImpl } = stubEndpoint([{ body: { idToken: 'not-even-a-jwt' } }]);
    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expiresAt.getTime()).toBe(NOW + 25 * 60_000);
  });

  it('prefers the OAuth expires_in over the 25-minute assumption', async () => {
    const { fetchImpl } = stubEndpoint([{ body: { idToken: 'opaque', expires_in: 900 } }]);
    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);
    expect(r.ok && r.expiresAt.getTime()).toBe(NOW + 900_000);
  });
});

describe('the manual override', () => {
  it('uses CORREOS_JWT as-is and never calls the endpoint', async () => {
    const token = jwtExpiring(inMinutes(45));
    process.env.CORREOS_JWT = token;
    const { calls, fetchImpl } = stubEndpoint([{ body: {} }]);

    const r = await new CorreosTokenProvider({ ...CLIENT, fetchImpl }).get(NOW);

    expect(r.ok && r.token).toBe(token);
    expect(r.ok && r.source).toBe('override');
    expect(calls).toHaveLength(0);
  });

  it('counts as configured on its own, with no OAuth credentials at all', async () => {
    process.env.CORREOS_JWT = jwtExpiring(inMinutes(45));
    expect(new CorreosTokenProvider({}).configured).toBe(true);
  });

  it('is not configured when nothing is set', () => {
    expect(new CorreosTokenProvider({}).configured).toBe(false);
  });
});

describe('reading exp out of a JWT', () => {
  it('reads a normal one', () => {
    expect(expiryOf(jwtExpiring(1800))).toBe(1_800_000);
  });

  it('returns null rather than throwing on anything odd', () => {
    expect(expiryOf('')).toBeNull();
    expect(expiryOf('one-part')).toBeNull();
    expect(expiryOf('a.b')).toBeNull();
    expect(expiryOf('a.!!!not-base64!!!.c')).toBeNull();
    expect(expiryOf(`a.${Buffer.from('{"sub":"x"}').toString('base64url')}.c`)).toBeNull();
    expect(expiryOf(`a.${Buffer.from('{"exp":"soon"}').toString('base64url')}.c`)).toBeNull();
  });

  it('refuses an exp that is obviously already in milliseconds', () => {
    // Treating it as seconds would park the expiry fifty thousand years out and
    // we would never renew.
    const ms = Date.UTC(2026, 9, 1, 12, 30, 0);
    expect(expiryOf(`a.${Buffer.from(JSON.stringify({ exp: ms })).toString('base64url')}.c`)).toBeNull();
  });
});
