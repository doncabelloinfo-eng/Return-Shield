import { describe, it, expect, beforeEach } from 'vitest';
import {
  TrackpubClient, MAX_BATCH, NEVER_HEARD_OF_IT, chunksOf, trackpub, setTrackpub,
} from '@/lib/carriers/correos/trackpub';
import { CorreosTokenProvider, clearTokenCache } from '@/lib/carriers/correos/token';

/**
 * The batch format is not documented, so this is where the guess is checked.
 *
 * The property that matters most: a code we asked about must never come back as
 * "no news" unless Correos actually said so about that code. Getting that wrong
 * would stamp parcels as freshly checked without checking them, and their
 * countdowns would go stale with nothing on any screen to say so.
 */

const GATEWAY = { clientId: 'gw-id', clientSecret: 'gw-secret' };

function jwt(expSeconds: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: expSeconds })}.sig`;
}

/** A token provider that never touches the network. */
function tokens(): CorreosTokenProvider {
  return new CorreosTokenProvider({
    clientId: 'oauth-id',
    clientSecret: 'oauth-secret',
    fetchImpl: (async () => new Response(
      JSON.stringify({ idToken: jwt(Math.floor(Date.now() / 1000) + 1800) }),
      { status: 200 },
    )) as unknown as typeof fetch,
  });
}

interface Recorded { url: string; auth: string }

/** A trackpub that answers from a queue of canned responses. */
function stub(answers: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const seen: Recorded[] = [];
  let i = 0;

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(url), auth: headers.Authorization ?? '' });
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return new Response(
      a.body === undefined ? '' : JSON.stringify(a.body),
      { status: a.status ?? 200, headers: { 'Content-Type': 'application/json', ...(a.headers ?? {}) } },
    );
  }) as unknown as typeof fetch;

  return { seen, fetchImpl };
}

function client(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}): TrackpubClient {
  return new TrackpubClient({
    ...GATEWAY,
    baseUrl: 'https://api1.correos.es/support/trackpub/api/v2',
    tokenProvider: tokens(),
    fetchImpl,
    ratePerSecond: 1000,
    maxRetries: 1,
    ...opts,
  });
}

/** One shipment, as Correos describes it. */
const shipment = (code: string, desc = 'Disponible en oficina para recoger') => ({
  codEnvio: code,
  eventos: [{ codEvento: 'E-05', desEvento: desc, fecEvento: '01/10/2026', horEvento: '11:30' }],
});

const A = 'PQ1000000001ES';
const B = 'PQ1000000002ES';
const C = 'PQ1000000003ES';

beforeEach(() => {
  clearTokenCache();
  delete process.env.CORREOS_JWT;
});

describe('being configured', () => {
  it('needs the gateway pair AND something that can mint a token', () => {
    const { fetchImpl } = stub([{ body: {} }]);

    expect(client(fetchImpl).configured).toBe(true);

    expect(new TrackpubClient({
      clientId: 'gw-id', clientSecret: '', tokenProvider: tokens(), fetchImpl,
    }).configured).toBe(false);

    expect(new TrackpubClient({
      ...GATEWAY, tokenProvider: new CorreosTokenProvider({}), fetchImpl,
    }).configured).toBe(false);
  });

  it('refuses to call with blanks rather than getting a confusing 401', async () => {
    const { seen, fetchImpl } = stub([{ body: {} }]);
    const c = new TrackpubClient({ clientId: '', clientSecret: '', tokenProvider: tokens(), fetchImpl });

    const r = await c.lookup(A);

    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe('a single lookup', () => {
  it('sends the gateway headers and the bearer token', async () => {
    const { seen, fetchImpl } = stub([{ body: shipment(A) }]);
    await client(fetchImpl).lookup(A);

    expect(seen[0].url).toBe(`https://api1.correos.es/support/trackpub/api/v2/search/${A}`);
    expect(seen[0].auth).toMatch(/^Bearer ey/);
  });

  it('normalises the events', async () => {
    const { fetchImpl } = stub([{ body: shipment(A) }]);
    const r = await client(fetchImpl).lookup(A);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome.events).toHaveLength(1);
    expect(r.outcome.events[0].shippingCode).toBe(A);
    expect(r.outcome.codesSeen).toEqual([A]);
  });

  it('reports a 404 as "never heard of it", not as an error to retry', async () => {
    const { fetchImpl } = stub([{ status: 404, body: { error: 'not found' } }]);
    const r = await client(fetchImpl).lookup(A);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
    expect(r.error).toBe(NEVER_HEARD_OF_IT);
    expect(r.retryable).toBe(false);
  });
});

describe('the token, in use', () => {
  it('is minted once and reused across many lookups', async () => {
    let minted = 0;
    const tokenProvider = new CorreosTokenProvider({
      clientId: 'oauth-id',
      clientSecret: 'oauth-secret',
      fetchImpl: (async () => {
        minted += 1;
        return new Response(JSON.stringify({ idToken: jwt(Math.floor(Date.now() / 1000) + 1800) }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const { fetchImpl } = stub([{ body: shipment(A) }]);
    const c = client(fetchImpl, { tokenProvider });

    await c.lookup(A);
    await c.lookup(B);
    await c.lookup(C);

    expect(minted).toBe(1);
  });

  it('throws the token away on a 401 and retries exactly once', async () => {
    let minted = 0;
    const tokenProvider = new CorreosTokenProvider({
      clientId: 'oauth-id',
      clientSecret: 'oauth-secret',
      fetchImpl: (async () => {
        minted += 1;
        return new Response(
          JSON.stringify({ idToken: jwt(Math.floor(Date.now() / 1000) + 1800) + `.${minted}` }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const { seen, fetchImpl } = stub([
      { status: 401, body: { error: 'expired' } },
      { body: shipment(A) },
    ]);

    const r = await client(fetchImpl, { tokenProvider }).lookup(A);

    expect(r.ok).toBe(true);
    expect(minted).toBe(2);
    expect(seen).toHaveLength(2);
    // The second call carried a different token than the first.
    expect(seen[0].auth).not.toBe(seen[1].auth);
  });

  it('gives up after one refresh rather than hammering the token endpoint', async () => {
    let minted = 0;
    const tokenProvider = new CorreosTokenProvider({
      clientId: 'oauth-id',
      clientSecret: 'oauth-secret',
      fetchImpl: (async () => {
        minted += 1;
        return new Response(JSON.stringify({ idToken: jwt(Math.floor(Date.now() / 1000) + 1800) }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    // Credentials that are simply wrong: every call 401s.
    const { seen, fetchImpl } = stub([{ status: 401, body: { error: 'invalid' } }]);
    const r = await client(fetchImpl, { tokenProvider }).lookup(A);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.retryable).toBe(false);
    expect(r.error).toContain('CORREOS_OAUTH_CLIENT_ID');
    expect(seen).toHaveLength(2);
    expect(minted).toBe(2);
  });

  it('does not refresh a token the operator supplied by hand', async () => {
    // There is nothing to refresh: a pasted token is all there is, and minting
    // over the top of it would hide the fact that it has expired.
    process.env.CORREOS_JWT = jwt(Math.floor(Date.now() / 1000) + 1800);
    const { seen, fetchImpl } = stub([{ status: 401, body: {} }]);

    const r = await client(fetchImpl, { tokenProvider: new CorreosTokenProvider({}) }).lookup(A);

    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe('batch lookups', () => {
  it('joins the codes with commas, each encoded on its own', async () => {
    // Encoding the joined string would turn the commas into %2C and ask about
    // one parcel with a very strange name.
    const { seen, fetchImpl } = stub([{ body: [shipment(A), shipment(B)] }]);
    await client(fetchImpl).lookupMany([A, B]);

    expect(seen[0].url).toBe(`https://api1.correos.es/support/trackpub/api/v2/search/${A},${B}`);
    expect(seen[0].url).not.toContain('%2C');
  });

  it('reads an answer that is an array', async () => {
    const { seen, fetchImpl } = stub([{ body: [shipment(A), shipment(B), shipment(C)] }]);
    const r = await client(fetchImpl).lookupMany([A, B, C]);

    expect(r.mode).toBe('comma');
    expect(r.requests).toBe(1);
    expect(seen).toHaveLength(1);
    for (const code of [A, B, C]) {
      const one = r.byCode.get(code);
      expect(one?.ok, code).toBe(true);
      if (one?.ok) expect(one.outcome.events[0].shippingCode).toBe(code);
    }
  });

  it('reads an answer that is a single object', async () => {
    // Asking about one code in batch mode, or a gateway that unwraps a
    // one-element array, both land here.
    const { fetchImpl } = stub([{ body: shipment(A) }]);
    const r = await client(fetchImpl).lookupMany([A]);

    const one = r.byCode.get(A);
    expect(one?.ok).toBe(true);
    if (one?.ok) expect(one.outcome.events).toHaveLength(1);
  });

  it('reads an answer wrapped in an envios key', async () => {
    const { fetchImpl } = stub([{ body: { envios: [shipment(A), shipment(B)] } }]);
    const r = await client(fetchImpl).lookupMany([A, B]);

    expect(r.mode).toBe('comma');
    expect(r.byCode.get(A)?.ok).toBe(true);
    expect(r.byCode.get(B)?.ok).toBe(true);
  });

  it('gives each parcel only its own events', async () => {
    const { fetchImpl } = stub([{
      body: [shipment(A, 'Disponible en oficina para recoger'), shipment(B, 'Entregado')],
    }]);
    const r = await client(fetchImpl).lookupMany([A, B]);

    const a = r.byCode.get(A);
    const b = r.byCode.get(B);
    expect(a?.ok && a.outcome.events.every((e) => e.shippingCode === A)).toBe(true);
    expect(b?.ok && b.outcome.events.every((e) => e.shippingCode === B)).toBe(true);
    // The normaliser keeps Correos' own words; the mapping to a state happens
    // at ingest, so what we check here is that the right words reached the
    // right parcel.
    expect(a?.ok && a.outcome.events[0].eventDesc).toBe('Disponible en oficina para recoger');
    expect(b?.ok && b.outcome.events[0].eventDesc).toBe('Entregado');
  });

  it('returns an entry for every code asked about, always', async () => {
    const { fetchImpl } = stub([{ body: [shipment(A)] }, { body: shipment(B) }, { status: 404, body: {} }]);
    const r = await client(fetchImpl).lookupMany([A, B, C]);
    expect([...r.byCode.keys()].sort()).toEqual([A, B, C].sort());
  });

  it('splits more than a hundred codes into separate requests', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `PQ9${String(i).padStart(9, '0')}ES`);
    const { seen, fetchImpl } = stub([{ body: many.map((c) => shipment(c)) }]);

    const r = await client(fetchImpl).lookupMany(many);

    expect(MAX_BATCH).toBe(100);
    expect(seen).toHaveLength(3);
    const firstBatch = seen[0].url.split('/search/')[1].split(',');
    expect(firstBatch).toHaveLength(100);
    expect(r.byCode.size).toBe(250);
  });

  it('de-duplicates the codes it was handed', async () => {
    const { seen, fetchImpl } = stub([{ body: [shipment(A)] }]);
    await client(fetchImpl).lookupMany([A, A, A.toLowerCase(), ` ${A} `]);
    expect(seen[0].url.split('/search/')[1]).toBe(A);
  });
});

describe('when the batch format does not work', () => {
  it('falls back to one request per parcel on a 400', async () => {
    const { seen, fetchImpl } = stub([
      { status: 400, body: { error: 'bad request' } },
      { body: shipment(A) },
      { body: shipment(B) },
    ]);
    const c = client(fetchImpl);
    const r = await c.lookupMany([A, B]);

    expect(r.mode).toBe('single');
    expect(r.batchDiagnosis).toContain('refused with 400');
    expect(seen).toHaveLength(3);
    expect(r.byCode.get(A)?.ok).toBe(true);
    expect(r.byCode.get(B)?.ok).toBe(true);
  });

  it('falls back when a 200 mentions none of the codes it asked about', async () => {
    // The dangerous case: without a coverage check this would read as "no news
    // about either parcel" and stamp both as freshly checked.
    const { seen, fetchImpl } = stub([
      { body: { mensaje: 'no hay resultados' } },
      { body: shipment(A) },
      { body: shipment(B) },
    ]);
    const r = await client(fetchImpl).lookupMany([A, B]);

    expect(r.mode).toBe('single');
    expect(r.batchDiagnosis).toContain('without any of the codes');
    expect(seen).toHaveLength(3);
    expect(r.byCode.get(A)?.ok).toBe(true);
  });

  it('stays in single mode for the rest of the run once it has fallen back', async () => {
    const codes = [A, B, C];
    const { seen, fetchImpl } = stub([
      { status: 400, body: {} },             // the probe
      ...codes.map((code) => ({ body: shipment(code) })),
      ...codes.map((code) => ({ body: shipment(code) })),
    ]);
    const c = client(fetchImpl);

    await c.lookupMany(codes);
    const before = seen.length;
    await c.lookupMany(codes);

    // No second probe: three more single requests, not four.
    expect(seen.length - before).toBe(3);
    expect(c.mode).toBe('single');
  });

  it('can be told the mode up front, so it does not re-probe every run', async () => {
    const { seen, fetchImpl } = stub([{ body: shipment(A) }, { body: shipment(B) }]);
    const r = await client(fetchImpl, { batchMode: 'single' }).lookupMany([A, B]);

    expect(seen).toHaveLength(2);
    expect(seen[0].url).not.toContain(',');
    expect(r.mode).toBe('single');
  });

  it('asks individually about the few codes a working batch left out', async () => {
    // Most came back, one did not. That one might be unknown to Correos or
    // might have been dropped — the only way to know is to ask.
    const { seen, fetchImpl } = stub([
      { body: [shipment(A), shipment(B)] },
      { status: 404, body: {} },
    ]);
    const r = await client(fetchImpl).lookupMany([A, B, C]);

    expect(r.mode).toBe('comma');
    expect(seen).toHaveLength(2);
    expect(seen[1].url).toContain(C);
    expect(r.byCode.get(C)?.ok).toBe(false);
    const c3 = r.byCode.get(C);
    if (c3 && !c3.ok) expect(c3.error).toBe(NEVER_HEARD_OF_IT);
  });

  it('treats a mostly-empty batch as a regression, not as unknown parcels', async () => {
    const { fetchImpl } = stub([
      { body: [shipment(A)] },
      { body: shipment(A) }, { body: shipment(B) }, { body: shipment(C) },
    ]);
    const r = await client(fetchImpl).lookupMany([A, B, C]);

    expect(r.mode).toBe('single');
    expect(r.batchDiagnosis).toContain('covered only 1');
  });
});

describe('a batch 404 and a single 404 are different things', () => {
  it('on the first probe, a 404 means the URL shape is wrong', async () => {
    const { seen, fetchImpl } = stub([
      { status: 404, body: {} },
      { body: shipment(A) },
      { body: shipment(B) },
    ]);
    const r = await client(fetchImpl).lookupMany([A, B]);

    expect(r.mode).toBe('single');
    // Both parcels got a real answer rather than being written off as unknown.
    expect(r.byCode.get(A)?.ok).toBe(true);
    expect(seen).toHaveLength(3);
  });

  it('once the format is proven, a 404 means none of those codes are known', async () => {
    const { seen, fetchImpl } = stub([
      { body: [shipment(A), shipment(B)] },   // proves comma works
      { status: 404, body: {} },              // a later batch: genuinely unknown
    ]);
    const c = client(fetchImpl);

    await c.lookupMany([A, B]);
    const r = await c.lookupMany([B, C]);

    expect(c.mode).toBe('comma');
    expect(seen).toHaveLength(2);
    for (const code of [B, C]) {
      const one = r.byCode.get(code);
      expect(one?.ok, code).toBe(false);
      if (one && !one.ok) expect(one.error).toBe(NEVER_HEARD_OF_IT);
    }
  });
});

describe('rate limiting and backoff', () => {
  it('waits and retries on a 429, honouring retry-after', async () => {
    const { seen, fetchImpl } = stub([
      { status: 429, body: {}, headers: { 'retry-after': '1' } },
      { body: shipment(A) },
    ]);

    const started = Date.now();
    const r = await client(fetchImpl).lookup(A);
    const took = Date.now() - started;

    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(900);
  });

  it('gives up retryably after a 429 it cannot get past', async () => {
    const { fetchImpl } = stub([{ status: 429, body: {}, headers: { 'retry-after': '1' } }]);
    const r = await client(fetchImpl, { maxRetries: 1 }).lookup(A);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(429);
    // Retryable, so the sweep stops rather than marking the parcel checked.
    expect(r.retryable).toBe(true);
  });

  it('does not change the batch mode because of a 429', async () => {
    // A rate limit says nothing about the URL shape. Falling back to one
    // request per parcel because of it would quadruple the request count at
    // exactly the moment the gateway is asking for fewer.
    const { fetchImpl } = stub([{ status: 429, body: {}, headers: { 'retry-after': '1' } }]);
    const c = client(fetchImpl, { maxRetries: 1, batchMode: 'comma' });

    const r = await c.lookupMany([A, B]);

    expect(c.mode).toBe('comma');
    expect(r.byCode.get(A)?.ok).toBe(false);
  });

  it('retries a 5xx', async () => {
    const { seen, fetchImpl } = stub([
      { status: 503, body: {}, headers: { 'retry-after': '1' } },
      { body: shipment(A) },
    ]);
    const r = await client(fetchImpl).lookup(A);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
  });
});

describe('what must not downgrade a format that works', () => {
  it('a whole chunk of codes Correos has never scanned', async () => {
    // The sweep queues parcels in `created` — a run of freshly printed labels
    // that do not exist on Correos' side yet. A 200 covering none of them is a
    // perfectly normal import, and treating it as "comma-separated is broken"
    // would turn fifty requests a run into five thousand, permanently, against
    // a gateway that rate-limits and publishes no numbers.
    const { fetchImpl } = stub([
      { body: [shipment(A), shipment(B)] },        // proves the format works
      { body: { mensaje: 'sin resultados' } },     // a chunk of brand-new labels
      { status: 404, body: {} },                   // each one, asked singly
    ]);
    const c = client(fetchImpl);

    await c.lookupMany([A, B]);
    expect(c.mode).toBe('comma');

    const r = await c.lookupMany(['PQ7000000001ES', 'PQ7000000002ES']);

    expect(c.mode).toBe('comma');
    expect(r.batchDiagnosis).toBeNull();
    // Still answered correctly, just the slow way for that chunk.
    expect(r.byCode.get('PQ7000000001ES')?.ok).toBe(false);
  });

  it('but an unproven format IS rejected by the same response', async () => {
    const { fetchImpl } = stub([
      { body: { mensaje: 'sin resultados' } },
      { body: shipment(A) },
      { body: shipment(B) },
    ]);
    const c = client(fetchImpl);

    await c.lookupMany([A, B]);

    expect(c.mode).toBe('single');
    expect(c.diagnosis).toContain('without any of the codes');
  });
});

describe('what it reports back', () => {
  it('does not claim to know the format when it never tested one', async () => {
    // Persisting 'single' from a run that learnt nothing would disable
    // batching for good.
    const { fetchImpl } = stub([{ body: shipment(A) }]);

    const nothing = await client(fetchImpl).lookupMany([]);
    expect(nothing.mode).toBe('unknown');

    const justOne = await client(fetchImpl).lookupMany([A]);
    expect(justOne.mode).toBe('unknown');
  });

  it('keeps the covered results when it decides the batch under-covered', async () => {
    const { fetchImpl } = stub([
      { body: [shipment(A)] },
      { body: shipment(B) },
      { body: shipment(C) },
    ]);
    const r = await client(fetchImpl).lookupMany([A, B, C]);

    // A came from the batch and was not re-asked; B and C were.
    expect(r.byCode.get(A)?.ok).toBe(true);
    expect(r.byCode.get(B)?.ok).toBe(true);
    expect(r.byCode.get(C)?.ok).toBe(true);
    expect(r.requests).toBe(3);
  });

  it('gives a parcel only its own problems, not those of codes it prefixes', async () => {
    // normalise tags problems `<code>: …`; without the colon PQ100…1ES would
    // also collect PQ100…1ESX's.
    const { fetchImpl } = stub([{
      body: [{ codEnvio: A, eventos: [] }, { codEnvio: `${A}X`, eventos: [] }],
    }]);
    const r = await client(fetchImpl).lookupMany([A, `${A}X`]);

    const one = r.byCode.get(A);
    expect(one?.ok).toBe(true);
    if (one?.ok) expect(one.outcome.problems.every((p) => p.startsWith(`${A}:`))).toBe(true);
  });
});

describe('how codes are split into requests', () => {
  it('caps at a hundred', () => {
    const many = Array.from({ length: 250 }, (_, i) => `PQ9${String(i).padStart(9, '0')}ES`);
    expect(chunksOf(many).map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it('also caps the length of the path', () => {
    // Undocumented, but a gateway with a URI limit answers 414 or 400 — and the
    // 400 path reads that as a broken format and downgrades permanently.
    const long = Array.from({ length: 100 }, (_, i) => `EXPEDITION-CODE-${String(i).padStart(40, '0')}`);
    const chunks = chunksOf(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.map((c) => encodeURIComponent(c)).join(',').length).toBeLessThanOrEqual(1800);
    }
  });

  it('never drops a code just because it is long', () => {
    const huge = 'X'.repeat(4000);
    expect(chunksOf([huge])).toEqual([[huge]]);
  });

  it('ordinary codes still chunk at the full hundred', () => {
    const normal = Array.from({ length: 100 }, (_, i) => `PQ78429310${String(i).padStart(2, '0')}ES`);
    expect(chunksOf(normal)).toHaveLength(1);
  });
});

describe('the shared client', () => {
  beforeEach(() => { setTrackpub(null); });

  it('lets a stored mode reach a client that already exists', async () => {
    // Without this an operator resetting correosBatchMode to probe the format
    // again is overruled by the warm instance, and the next sweep writes the
    // stale verdict back over the reset.
    const first = trackpub({ clientId: 'a', clientSecret: 'b', batchMode: 'single' });
    expect(first.mode).toBe('single');

    const again = trackpub({ clientId: 'a', clientSecret: 'b', batchMode: 'unknown' });
    expect(again).toBe(first);
    expect(again.mode).toBe('unknown');
  });

  it('does not let a stale stored mode overrule what this instance has learnt', async () => {
    const c = trackpub({ clientId: 'a', clientSecret: 'b', batchMode: 'unknown' });
    c.adoptMode('comma');
    trackpub({ clientId: 'a', clientSecret: 'b', batchMode: 'single' });
    expect(c.mode).toBe('comma');
  });
});
