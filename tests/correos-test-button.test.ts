import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// The action calls requireUser(), which reads the request's cookies. There is
// no request here, so the guard is stubbed — but it is stubbed with a spy, and
// one test below asserts the action actually calls it. "Logged-in users only"
// is part of what the button is, not an incidental detail: anonymously
// available, it would let anyone on the internet make us mint carrier tokens.
const requireUser = vi.fn(async () => ({ id: 'u1', email: 'op@example.com', name: 'Op' }));
vi.mock('@/lib/auth/guard', () => ({ requireUser }));

const { testCorreosConnection, resetCorreosBatchMode } = await import('@/app/actions/correos');
const { CorreosTokenProvider, setCorreosToken, clearTokenCache } =
  await import('@/lib/carriers/correos/token');
const { getSetting, setSetting } = await import('@/lib/settings');
const { resetDb, closeDb } = await import('./helpers/db');
const { REAL_SEARCH_RESPONSE, REAL_CODE, v2Shipment, v2Event } = await import('./helpers/correos');

/**
 * The button exists because four variables from two different places have to be
 * right before one parcel gets tracked, and the alternative way to find out is
 * to wait three hours for a sweep and read a job_runs row.
 *
 * The property these tests guard hardest is the one that is not about
 * correctness: the token must not come back. Not truncated, not its length. It
 * would end up in a browser, a server log and a screenshot of the Settings
 * screen pasted into a chat.
 */

const SECRET = 'a-token-that-must-never-be-returned.aaaa.bbbb';

function jwt(secondsFromNow: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.${SECRET}`;
}

let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

/** Answers the token endpoint, then trackpub from a queue. */
function stubNetwork(trackpubAnswers: Array<{ status?: number; body?: unknown }>) {
  let i = 0;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    fetchCalls.push(u);
    if (u.includes('Authorize/Token')) {
      return new Response(JSON.stringify({ idToken: jwt(1800) }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    const a = trackpubAnswers[Math.min(i, trackpubAnswers.length - 1)] ?? { status: 200, body: [] };
    i += 1;
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), {
      status: a.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const shipment = (code: string, desc: string, codEvento: string) => ({
  codEnvio: code,
  eventos: [{
    codEvento,
    desEvento: desc,
    fecEvento: '01/10/2026',
    horEvento: '09:14',
    desOficina: 'Oficina Madrid Centro',
  }],
});

beforeEach(async () => {
  await resetDb();
  fetchCalls = [];
  requireUser.mockClear();
  clearTokenCache();
  setCorreosToken(null);
  process.env.CORREOS_CLIENT_ID = 'gateway-id';
  process.env.CORREOS_CLIENT_SECRET = 'gateway-secret';
  process.env.CORREOS_OAUTH_CLIENT_ID = 'oauth-id';
  process.env.CORREOS_OAUTH_CLIENT_SECRET = 'oauth-secret';
  delete process.env.CORREOS_JWT;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setCorreosToken(null);
  clearTokenCache();
  for (const k of ['CORREOS_CLIENT_ID', 'CORREOS_CLIENT_SECRET',
    'CORREOS_OAUTH_CLIENT_ID', 'CORREOS_OAUTH_CLIENT_SECRET', 'CORREOS_JWT']) {
    delete process.env[k];
  }
});

afterAll(async () => { await closeDb(); });

describe('step 1: the token', () => {
  it('says how long the token lasts without saying what it is', async () => {
    stubNetwork([]);

    const result = await testCorreosConnection('');

    expect(result.token.ok).toBe(true);
    expect(result.token.expiresInMinutes).toBe(30);
    expect(result.token.message).toBe('Token OK, expires in 30 minutes.');

    // The whole point. Serialised, because this object crosses to the browser.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('oauth-secret');
    expect(JSON.stringify(result)).not.toContain('gateway-secret');
  });

  it('refuses to run for anyone who is not logged in', async () => {
    stubNetwork([]);
    await testCorreosConnection('');
    expect(requireUser).toHaveBeenCalledOnce();
  });

  it('names the two variables to set when there are no credentials', async () => {
    delete process.env.CORREOS_OAUTH_CLIENT_ID;
    delete process.env.CORREOS_OAUTH_CLIENT_SECRET;
    setCorreosToken(null);
    stubNetwork([]);

    const result = await testCorreosConnection('PQ123');

    expect(result.token.ok).toBe(false);
    expect(result.token.message).toContain('CORREOS_OAUTH_CLIENT_ID');
    expect(result.token.message).toContain('CORREOS_OAUTH_CLIENT_SECRET');
    // No token, so step 2 was never attempted, and nothing was asked of Correos.
    expect(result.lookup).toBeUndefined();
    expect(fetchCalls).toEqual([]);
  });

  it('reports the token endpoint failing, without the lookup', async () => {
    globalThis.fetch = (async (url: unknown) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
    }) as unknown as typeof fetch;

    const result = await testCorreosConnection('PQ123');

    expect(result.token.ok).toBe(false);
    expect(result.token.message).toContain('401');
    expect(result.lookup).toBeUndefined();
  });

  it('warns that a hand-pasted CORREOS_JWT cannot be renewed', async () => {
    process.env.CORREOS_JWT = jwt(600);
    setCorreosToken(new CorreosTokenProvider());
    stubNetwork([]);

    const result = await testCorreosConnection('');

    expect(result.token.ok).toBe(true);
    expect(result.token.manual).toBe(true);
    expect(result.token.message).toContain('cannot be renewed');
    // The override must not be echoed back either.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Nothing was fetched: the override is the token.
    expect(fetchCalls.filter((u) => u.includes('Authorize/Token'))).toEqual([]);
  });

  it('mints a fresh token rather than trusting a cached one', async () => {
    stubNetwork([]);
    await testCorreosConnection('');
    await testCorreosConnection('');
    // A cached token proves only that it worked earlier, which is not what the
    // operator pressed the button to find out.
    expect(fetchCalls.filter((u) => u.includes('Authorize/Token'))).toHaveLength(2);
  });
});

describe('step 2: the lookup', () => {
  it('maps a real answer to a state and an event count', async () => {
    stubNetwork([{ body: [shipment('PQ1', 'Disponible en oficina para recoger', 'ENOF')] }]);

    const result = await testCorreosConnection('pq1');

    expect(result.token.ok).toBe(true);
    expect(result.lookup?.ok).toBe(true);
    // Lower case in, upper case out: the operator types what is on the label.
    expect(result.lookup?.code).toBe('PQ1');
    expect(result.lookup?.events).toBe(1);
    expect(result.lookup?.state).toBeTruthy();
    expect(result.lookup?.latestEvent).toContain('Disponible en oficina');
  });

  it('distinguishes "known but no events" from "never heard of it"', async () => {
    stubNetwork([{ body: [{ codEnvio: 'PQ2', eventos: [] }] }]);

    const known = await testCorreosConnection('PQ2');
    expect(known.lookup?.ok).toBe(true);
    expect(known.lookup?.events).toBe(0);
    expect(known.lookup?.message).toContain('no events for it yet');

    stubNetwork([{ status: 404, body: { error: 'not found' } }]);
    const unknown = await testCorreosConnection('PQ3');
    expect(unknown.lookup?.ok).toBe(false);
    expect(unknown.lookup?.status).toBe(404);
  });

  it('passes Correos\' own status and message through on a failure', async () => {
    stubNetwork([{ status: 403, body: { message: 'client_id not authorised for this instance' } }]);

    const result = await testCorreosConnection('PQ4');

    // The token worked; the gateway credential is the wrong one. Two steps, so
    // the operator knows which of the four variables to go and look at.
    expect(result.token.ok).toBe(true);
    expect(result.lookup?.ok).toBe(false);
    expect(result.lookup?.status).toBe(403);
  });

  it('skips the lookup when no code was typed', async () => {
    stubNetwork([]);
    const result = await testCorreosConnection('   ');
    expect(result.token.ok).toBe(true);
    expect(result.lookup).toBeUndefined();
    expect(fetchCalls.filter((u) => u.includes('/search/'))).toEqual([]);
  });

  it('keeps wording it has no mapping for, and says so', async () => {
    stubNetwork([{ body: [shipment('PQ5', 'Algo que no hemos visto nunca', 'ZZZZ')] }]);

    const result = await testCorreosConnection('PQ5');

    expect(result.lookup?.ok).toBe(true);
    expect(result.lookup?.events).toBe(1);
    expect(result.lookup?.message).toContain('no mapping for');
  });
});

describe('what it says when Correos says no', () => {
  it('shows their status and their body, not our guess at the cause', async () => {
    // The whole reason this test exists: the action used to report
    // "Correos rejected the token. Check CORREOS_OAUTH_CLIENT_ID…" on a 401.
    // The credentials were right; the OAuth scope was wrong. Correos' own
    // three-word body would have said so immediately.
    stubNetwork([{ status: 401, body: { error: 'Invalid token.' } }]);

    const result = await testCorreosConnection('PQX');

    expect(result.token.ok).toBe(true);
    expect(result.lookup?.ok).toBe(false);
    expect(result.lookup?.status).toBe(401);
    expect(result.lookup?.message).toContain('401');
    expect(result.lookup?.message).toContain('Invalid token.');
  });

  it('mentions the scope on a 401, since that is what it turned out to be', async () => {
    stubNetwork([{ status: 401, body: { error: 'Invalid token.' } }]);
    const result = await testCorreosConnection('PQX');
    // A hint after their body, never instead of it.
    expect(result.lookup?.message).toContain('CORREOS_OAUTH_SCOPE');
  });

  it('shows the body on a 400 as well', async () => {
    stubNetwork([{ status: 400, body: { error: 'JWT Token is required.' } }]);

    const result = await testCorreosConnection('PQX');

    expect(result.lookup?.status).toBe(400);
    expect(result.lookup?.message).toContain('JWT Token is required.');
  });

  it('trims a body that goes on', async () => {
    stubNetwork([{ status: 500, body: { error: 'x'.repeat(2000) } }]);

    const result = await testCorreosConnection('PQX');

    // Long enough to diagnose, short enough to put on a screen.
    expect((result.lookup?.message ?? '').length).toBeLessThan(500);
  });
});

describe('what it says when the lookup works', () => {
  it('reports the event count, the newest event with its time, and the state', async () => {
    stubNetwork([{ body: REAL_SEARCH_RESPONSE }]);

    const result = await testCorreosConnection(REAL_CODE);

    expect(result.lookup?.ok).toBe(true);
    expect(result.lookup?.events).toBe(3);
    // The newest of the three is "Clasificado" at 20:13:43 Madrid.
    expect(result.lookup?.latestEvent).toContain('Clasificado');
    expect(result.lookup?.latestEvent).toContain('20:13');
    expect(result.lookup?.latestEvent).toContain('6 Oct');
    expect(result.lookup?.state).toBe('On the way');
    expect(result.lookup?.message).toBe('3 events.');
  });

  it('says so when only the phase recognised the newest event', async () => {
    stubNetwork([{ body: [v2Shipment(REAL_CODE, [v2Event('ZZ999', 'Una cosa nueva', 'EN CAMINO')])] }]);

    const result = await testCorreosConnection(REAL_CODE);

    expect(result.lookup?.state).toBe('On the way');
    expect(result.lookup?.message).toContain('phase');
    expect(result.lookup?.message).toContain('review');
  });

  it('reports a per-shipment error rather than "no events yet"', async () => {
    stubNetwork([{ body: [{ code: REAL_CODE, events: [], error: { codError: 1, desError: 'Envío no encontrado' } }] }]);

    const result = await testCorreosConnection(REAL_CODE);

    expect(result.lookup?.ok).toBe(false);
    expect(result.lookup?.message).toContain('Envío no encontrado');
  });
});

describe('the batch mode it reports', () => {
  it('shows what is stored, and does not change it', async () => {
    await setSetting('correosBatchMode', 'comma');
    stubNetwork([{ body: [shipment('PQ6', 'Entregado', 'ENTR')] }]);

    const result = await testCorreosConnection('PQ6');

    expect(result.batchMode).toBe('comma');
    // A test must not be able to teach the sweep anything: it runs one code
    // through a client of its own, which is not evidence about the format.
    expect(await getSetting('correosBatchMode')).toBe('comma');
  });

  it('can be reset, so the next sweep probes the format again', async () => {
    await setSetting('correosBatchMode', 'single');
    await resetCorreosBatchMode();
    expect(await getSetting('correosBatchMode')).toBe('unknown');
    expect(requireUser).toHaveBeenCalledOnce();
  });
});
