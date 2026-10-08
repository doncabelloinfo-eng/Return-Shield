import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  TrackpubClient, chunksOf, halve, nextSizeUp, shouldProbeLargerBatch,
  MAX_BATCH, MIN_BATCH,
} from '@/lib/carriers/correos/trackpub';
import { CorreosTokenProvider } from '@/lib/carriers/correos/token';
import { getSetting, setSetting } from '@/lib/settings';
import { resetDb, closeDb } from './helpers/db';

/**
 * A refused batch is halved, not given up on.
 *
 * On production a batch of 75 was refused with an HTML 403, and the client did
 * what it was written to do: fell back to one request per parcel, for the life
 * of the instance. So all 201 parcels got their own request — 114 seconds of a
 * function being alive — and nobody ever found out whether 37 would have
 * worked.
 *
 * Now a refusal halves the size and tries again: 75 → 37 → 18 → 9 → 4 → 2, and
 * only a refused batch of two means one parcel per request. The largest size
 * that worked is remembered, and once a day the sweep tries double it.
 *
 * Why bother when the operator has said one-per-request is acceptable: Vercel
 * bills memory for the whole time a function is alive, and this sweep spends
 * nearly all of its life waiting on Correos. Batches do not make it cheaper
 * per parcel — they make the run shorter, which is the thing being billed.
 */

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 1800 })}.sig`;

function tokens(): CorreosTokenProvider {
  return new CorreosTokenProvider({
    clientId: 'oauth-id',
    clientSecret: 'oauth-secret',
    fetchImpl: (async () => new Response(JSON.stringify({ idToken: jwt() }), { status: 200 })) as unknown as typeof fetch,
  });
}

/**
 * A gateway that refuses any batch larger than `accepts`, the way the real one
 * did: an HTML 403, not a JSON error.
 */
function gateway(accepts: number) {
  const sizes: number[] = [];
  const fetchImpl = (async (url: unknown) => {
    const codes = decodeURIComponent(String(url).split('/search/')[1]).split(',');
    sizes.push(codes.length);
    if (codes.length > accepts) {
      return new Response('<html><body>Forbidden</body></html>', {
        status: 403, headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response(JSON.stringify(codes.map((code) => ({ code, events: [] }))), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { sizes, fetchImpl };
}

function client(fetchImpl: typeof fetch, batchSize = 0): TrackpubClient {
  return new TrackpubClient({
    baseUrl: 'https://trackpub.example',
    clientId: 'gw-id',
    clientSecret: 'gw-secret',
    tokenProvider: tokens(),
    fetchImpl,
    // The rate limit is real and irrelevant here; it would only make the test
    // take a minute and a half.
    ratePerSecond: 100_000,
    batchSize,
  });
}

const codes = (n: number) =>
  Array.from({ length: n }, (_, i) => `PQ${String(i).padStart(10, '0')}ES`);

/** The distinct sizes asked for, in order, with repeats collapsed. */
function ladderOf(sizes: number[]): number[] {
  const out: number[] = [];
  for (const s of sizes) if (out[out.length - 1] !== s) out.push(s);
  return out;
}

beforeEach(resetDb);
afterAll(closeDb);

describe('halving', () => {
  it('walks the ladder the brief describes', () => {
    expect(halve(75)).toBe(37);
    expect(halve(37)).toBe(18);
    expect(halve(18)).toBe(9);
    expect(halve(9)).toBe(4);
    expect(halve(4)).toBe(2);
  });

  it('bottoms out at one, which is the single path', () => {
    expect(MIN_BATCH).toBe(2);
    expect(halve(2)).toBe(1);
    expect(halve(1)).toBe(1);
  });

  it('doubles a known size for the daily probe, capped at the documented limit', () => {
    expect(nextSizeUp(1)).toBe(2);
    expect(nextSizeUp(18)).toBe(36);
    expect(nextSizeUp(75)).toBe(MAX_BATCH);
    // Nothing known: the ceiling is worth trying.
    expect(nextSizeUp(0)).toBe(MAX_BATCH);
  });
});

describe('when Correos refuses a batch', () => {
  it('tries 37, then 18, and so on down to 2 before going single', async () => {
    // Nothing but one-at-a-time is accepted, so the whole ladder is walked.
    const g = gateway(0);
    const c = client(g.fetchImpl);

    const r = await c.lookupMany(codes(40));

    // Starts at the documented ceiling and halves each time it is refused.
    expect(ladderOf(g.sizes)).toEqual([40, 20, 10, 5, 2, 1]);
    expect(r.mode).toBe('single');
    expect(r.batchSize).toBe(1);
    expect(r.batchDiagnosis).toContain('falling back to one request per parcel');
    // And every parcel still got an answer. Narrowing must never lose one.
    expect(r.byCode.size).toBe(40);
    expect(r.notReached).toEqual([]);
  });

  it('only goes single when a batch of two is refused', async () => {
    const g = gateway(2);
    const c = client(g.fetchImpl);

    const r = await c.lookupMany(codes(9));

    expect(ladderOf(g.sizes)).toEqual([9, 4, 2, 1]);
    // A two worked, so it is not the single mode — the trailing 1 is the odd
    // code left over from splitting nine into twos.
    expect(r.mode).toBe('comma');
    expect(r.batchSize).toBe(2);
    expect(r.byCode.size).toBe(9);
  });

  it('stops at the first size that works', async () => {
    const g = gateway(18);
    const c = client(g.fetchImpl);

    const r = await c.lookupMany(codes(60));

    // 60 and 30 refused; 15 accepted. Halving finds *a* working size, not the
    // largest possible one — the daily probe is what climbs back up.
    expect(ladderOf(g.sizes).slice(0, 3)).toEqual([60, 30, 15]);
    expect(r.mode).toBe('comma');
    expect(r.batchSize).toBe(15);
    expect(r.byCode.size).toBe(60);
  });

  it('halves from the size that was refused, not from the ceiling', async () => {
    const g = gateway(4);
    const c = client(g.fetchImpl);
    await c.lookupMany(codes(20));

    // 20 refused, 10 refused, 5 refused — 5 is still above what this gateway
    // takes — and 2 accepted. Each step halves the size that was actually
    // refused, which is why the ladder is not a fixed list of numbers.
    expect(ladderOf(g.sizes)).toEqual([20, 10, 5, 2]);
    // And the diagnosis is cleared once a size works, so the Settings screen
    // stops reporting a refusal that has been dealt with.
    expect(c.diagnosis).toBeNull();
  });

  it('does not narrow on a rate limit, which is not about the format', async () => {
    const sizes: number[] = [];
    let first = true;
    const fetchImpl = (async (url: unknown) => {
      const list = decodeURIComponent(String(url).split('/search/')[1]).split(',');
      sizes.push(list.length);
      // Rate limited once, then fine. The client retries a 429 rather than
      // reading it as a verdict about the URL shape.
      if (first) { first = false; return new Response('', { status: 429 }); }
      return new Response(JSON.stringify(list.map((code) => ({ code, events: [] }))), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const c = client(fetchImpl);
    const r = await c.lookupMany(codes(10));

    /*
     * The size never moved. That is the whole point: a 429 or a 5xx says
     * Correos is busy or unwell, not that comma-separated codes are wrong, and
     * narrowing on one would turn a bad ten minutes into one request per
     * parcel for the rest of the day.
     */
    expect(sizes).toEqual([10, 10]);
    expect(c.limit).toBe(MAX_BATCH);
    expect(r.byCode.size).toBe(10);
    expect([...r.byCode.values()].every((v) => v.ok)).toBe(true);
  });

  it('reports a rate limit against the parcels rather than losing them', async () => {
    // Every attempt refused, so the retries run out. The codes come back as
    // retryable failures — which means the sweep does not stamp them as
    // checked, and they lead the next run's queue.
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const c = new TrackpubClient({
      baseUrl: 'https://trackpub.example',
      clientId: 'gw-id',
      clientSecret: 'gw-secret',
      tokenProvider: tokens(),
      fetchImpl,
      ratePerSecond: 100_000,
      maxRetries: 0,
    });

    const r = await c.lookupMany(codes(4));

    expect(c.limit).toBe(MAX_BATCH);
    expect([...r.byCode.values()].every((v) => !v.ok && v.retryable)).toBe(true);
  });
});

describe('the size it remembers', () => {
  it('starts from a remembered size, with no refusal at all', async () => {
    const g = gateway(18);
    const c = client(g.fetchImpl, 18);

    const r = await c.lookupMany(codes(60));

    // 60 = 3 × 18 + 6. No refusals: the ladder was walked once, yesterday.
    expect(ladderOf(g.sizes)).toEqual([18, 6]);
    expect(g.sizes.every((s) => s <= 18)).toBe(true);
    expect(r.batchSize).toBe(18);
  });

  it('starts single when the remembered size is one', async () => {
    const g = gateway(100);
    const c = client(g.fetchImpl, 1);

    await c.lookupMany(codes(5));

    // Not a falsy-zero mix-up: 1 is a real answer and has to survive.
    expect(g.sizes).toEqual([1, 1, 1, 1, 1]);
    expect(c.mode).toBe('single');
  });

  it('reports nothing learnt rather than a verdict it never reached', async () => {
    const g = gateway(100);
    const c = client(g.fetchImpl);

    const r = await c.lookupMany([]);

    // 0, so the caller leaves the stored size alone. Writing a size here
    // would throw away a known-good one on a run that never asked anything.
    expect(r.batchSize).toBe(0);
  });
});

describe('what gets written back to settings', () => {
  it('reports only what it demonstrated, never the size it was handed', async () => {
    // The bug this is here for: the daily probe hands in a size to TRY, and
    // seeding "proven" from it wrote 100 into settings on a run where a batch
    // of six was the largest thing that ever left the building.
    const g = gateway(100);
    const c = client(g.fetchImpl, 100);

    const r = await c.lookupMany(codes(6));

    expect(g.sizes).toEqual([6]);
    expect(r.batchSize).toBe(6);
    expect(c.narrowed).toBe(false);
  });

  it('says it narrowed only when a refusal actually lowered the size', async () => {
    const quiet = client(gateway(100).fetchImpl);
    await quiet.lookupMany(codes(10));
    expect(quiet.narrowed).toBe(false);

    const refused = client(gateway(2).fetchImpl);
    await refused.lookupMany(codes(10));
    expect(refused.narrowed).toBe(true);
  });

  it('learns nothing from a run that never asked anything', async () => {
    const c = client(gateway(100).fetchImpl, 18);
    const r = await c.lookupMany([]);
    // 0, so the caller leaves 18 in settings rather than overwriting it.
    expect(r.batchSize).toBe(0);
    expect(c.narrowed).toBe(false);
  });
});

describe('the once-a-day probe', () => {
  it('is due when nothing has ever been probed', () => {
    expect(shouldProbeLargerBatch('', new Date('2026-10-08T12:00:00Z'))).toBe(true);
  });

  it('is not due again within the day', () => {
    const at = new Date('2026-10-08T12:00:00Z');
    expect(shouldProbeLargerBatch('2026-10-08T06:00:00.000Z', at)).toBe(false);
    expect(shouldProbeLargerBatch('2026-10-07T13:00:00.000Z', at)).toBe(false);
  });

  it('is due once a day has gone by', () => {
    const at = new Date('2026-10-08T12:00:00Z');
    expect(shouldProbeLargerBatch('2026-10-07T12:00:00.000Z', at)).toBe(true);
    expect(shouldProbeLargerBatch('2026-10-01T12:00:00.000Z', at)).toBe(true);
  });

  it('is due when the stamp is nonsense rather than never', () => {
    expect(shouldProbeLargerBatch('not a date', new Date())).toBe(true);
  });

  it('survives a round trip through settings', async () => {
    await setSetting('correosBatchSize', 18);
    await setSetting('correosBatchProbedAt', '2026-10-07T12:00:00.000Z');
    expect(await getSetting('correosBatchSize')).toBe(18);
    expect(await getSetting('correosBatchProbedAt')).toBe('2026-10-07T12:00:00.000Z');
  });

  it('defaults to nothing known, so a fresh install probes', async () => {
    expect(await getSetting('correosBatchSize')).toBe(0);
    expect(await getSetting('correosBatchProbedAt')).toBe('');
    expect(shouldProbeLargerBatch(await getSetting('correosBatchProbedAt'), new Date())).toBe(true);
  });
});

describe('chunking', () => {
  it('splits at the limit it is given', () => {
    expect(chunksOf(codes(10), 4).map((c) => c.length)).toEqual([4, 4, 2]);
    expect(chunksOf(codes(10), 1).map((c) => c.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('never exceeds the documented ceiling, whatever it is asked for', () => {
    expect(chunksOf(codes(250), 1000)[0].length).toBeLessThanOrEqual(MAX_BATCH);
  });

  it('still caps the path length, which is what decided the size in production', () => {
    // 1,800 bytes of 23-character codes is about 75 — which is why the batch
    // Correos refused was 75 rather than the 100 the ceiling allows.
    const long = Array.from({ length: 100 }, (_, i) => `PKA6TP98000947401489${String(i).padStart(3, '0')}F`);
    const first = chunksOf(long, MAX_BATCH)[0];
    expect(first.length).toBeLessThan(MAX_BATCH);
    expect(first.length).toBeGreaterThan(60);
  });

  it('gives a single long code its own chunk rather than refusing it', () => {
    const huge = 'X'.repeat(4000);
    expect(chunksOf([huge], MAX_BATCH)).toEqual([[huge]]);
  });
});
