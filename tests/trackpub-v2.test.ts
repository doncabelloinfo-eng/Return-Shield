import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { eventReviewQueue, shipmentEvents, shipments } from '@/db/schema';
import { ingestEvent } from '@/lib/shipments/ingest';
import { normalisePayload, unmappedIn } from '@/lib/carriers/correos/normalise';
import {
  matchCorreosEvent, mapCorreosEvent, needsReview, normaliseDesc, normalisePhase, knownCodes,
} from '@/lib/carriers/correos/state-map';
import { TrackpubClient } from '@/lib/carriers/correos/trackpub';
import { CorreosTokenProvider } from '@/lib/carriers/correos/token';
import { REAL_SEARCH_RESPONSE, REAL_CODE, v2Shipment, v2Event } from './helpers/correos';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The trackpub v2 response shape, against the real thing.
 *
 * This file exists because of a failure that looked like success. The token
 * worked, the lookup returned 200, and the Settings test button reported
 * "Correos knows the code but has no events for it yet" — about a parcel with
 * three events, because `normalise.ts` read `codEnvio`, `desEvento` and
 * `horEvento`, and the real response says `code`, `summaryText` and
 * `eventHours`. Nothing anywhere said the parse had failed; every parcel would
 * simply have sat at `created` until its deposit window ran out.
 *
 * So the fixture is a verbatim capture rather than something written to match
 * the parser, nulls and all.
 */

const GATEWAY = { clientId: 'gw-id', clientSecret: 'gw-secret' };

function jwt(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 1800 })}.sig`;
}

function tokens(): CorreosTokenProvider {
  return new CorreosTokenProvider({
    clientId: 'oauth-id',
    clientSecret: 'oauth-secret',
    fetchImpl: (async () => new Response(JSON.stringify({ idToken: jwt() }), { status: 200 })) as unknown as typeof fetch,
  });
}

function stub(answers: Array<{ status?: number; body?: unknown }>) {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), {
      status: a.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
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

/* ========================================================================== */

describe('the real /search response', () => {
  it('parses all three events', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    expect(out.events).toHaveLength(3);
    expect(out.errors).toEqual([]);
    expect(out.events.map((e) => e.eventCode)).toEqual(['A090000V', 'A010000V', 'P040000V']);
    // No "could not read" or "no events" complaints: the shape is understood.
    expect(out.problems).toEqual([]);
  });

  it('reads the tracking code from `code`', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    expect(out.codesSeen).toEqual([REAL_CODE]);
    expect(out.events.every((e) => e.shippingCode === REAL_CODE)).toBe(true);
  });

  it('prefers summaryText and keeps expandedText on the payload', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    expect(out.events[0].eventDesc).toBe('Prerregistrado');
    // Both survive: the parcel timeline shows the short one, and the long one
    // is what a human reads when deciding what a new code means.
    const raw = out.events[0].rawPayload as Record<string, unknown>;
    expect(raw.summaryText).toBe('Prerregistrado');
    expect(raw.expandedText).toBe('Envío prerregistrado en los sistemas de Correos pendiente de depósito');
  });

  it('falls back to expandedText when there is no summary', () => {
    const out = normalisePayload([v2Shipment('PQ1', [{
      eventDate: '06/10/2026', eventHours: '09:00:00', eventCode: 'X1',
      summaryText: null, expandedText: 'Sólo el texto largo',
    }])], 'poll');

    expect(out.events).toHaveLength(1);
    expect(out.events[0].eventDesc).toBe('Sólo el texto largo');
  });

  it('reads the time from eventHours, to the second', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    // 06/10/2026 is CEST, so Madrid is UTC+2: 16:17:03 local is 14:17:03Z.
    expect(out.events[0].occurredAt.toISOString()).toBe('2026-10-06T14:17:03.000Z');
    expect(out.events[1].occurredAt.toISOString()).toBe('2026-10-06T18:13:23.000Z');
    // Seconds are kept, and they matter: the two later events are 20 seconds
    // apart, and `UNIQUE(shipment_id, event_code, occurred_at)` is the dedupe
    // key. Rounding them to the minute would not collide here, but it would
    // the moment Correos sends two events in the same minute.
    expect(out.events[2].occurredAt.toISOString()).toBe('2026-10-06T18:13:43.000Z');
  });

  it('keeps the shipment-level fields on every event', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');
    const raw = out.events[0].rawPayload as { shipment: Record<string, unknown> };

    expect(raw.shipment.reference1).toBe('#22430');
    expect(raw.shipment.reference3).toBe('MODULO_Shopify/v1.2.99');
    expect(raw.shipment.expeditionCode).toBe('PKA6TP980009510M');
    expect(raw.shipment.weight).toBe(2900);
    // Null in this capture, so absent rather than stored as null.
    expect(raw.shipment.dateExpiration).toBeUndefined();
  });

  it('does not copy the events array onto each event', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');
    const raw = out.events[0].rawPayload as { shipment: Record<string, unknown> };

    // The shipment context is a fixed list of fields on purpose. Spreading the
    // whole shipment would store a hundred events a hundred times over in a
    // batch — the jsonb column would be the size of the response squared.
    expect(raw.shipment.events).toBeUndefined();
    expect(raw.shipment.associatedShipments).toBeUndefined();
  });

  it('carries the phase through', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    expect(out.events[0].phase).toBe('PRE-ADMISIÓN');
    expect(out.events[1].phase).toBe('EN CAMINO');
  });

  it('leaves the office fields alone when Correos sends nulls', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    expect(out.events[0].officeCode).toBeNull();
    expect(out.events[0].officeName).toBeNull();
    expect(out.events[0].officeAddress).toBeNull();
  });

  it('maps codired and unit once they are present', () => {
    const out = normalisePayload([v2Shipment('PQ9', [{
      ...v2Event('A010000V', 'Admitido.'),
      codired: '28001',
      unit: 'OFICINA MADRID CENTRO',
      // Deliberately not mapped: `location` could be a town, a depot or a
      // shelf, and nothing we have seen says which.
      location: 'MADRID',
      sectionCode: '07',
    }])], 'poll');

    expect(out.events[0].officeCode).toBe('28001');
    expect(out.events[0].officeName).toBe('OFICINA MADRID CENTRO');
    const raw = out.events[0].rawPayload as Record<string, unknown>;
    expect(raw.location).toBe('MADRID');
    expect(raw.sectionCode).toBe('07');
  });

  it('still reads the old push-feed spelling', () => {
    // The Track&TracePush body is a different shape and this file has to keep
    // reading it: the two feeds describe the same events in different words.
    const out = normalisePayload({
      codEnvio: 'PQ2',
      eventos: [{ codEvento: 'E-05', desEvento: 'Entregado', fecEvento: '06/10/2026', horEvento: '11:30' }],
    }, 'push');

    expect(out.events).toHaveLength(1);
    expect(out.events[0].shippingCode).toBe('PQ2');
    expect(out.events[0].eventDesc).toBe('Entregado');
  });
});

/* ========================================================================== */

describe('a per-shipment error inside a 200', () => {
  it('is reported rather than read as "no news"', () => {
    const out = normalisePayload([{
      code: 'PQ3',
      events: [],
      error: { codError: 1, desError: 'Envío no encontrado' },
    }], 'poll');

    expect(out.errors).toEqual([{ code: 'PQ3', codError: 1, desError: 'Envío no encontrado' }]);
    expect(out.problems.join(' ')).toContain('Envío no encontrado');
    expect(out.events).toEqual([]);
  });

  it('counts the code as answered, so a batch does not ask twice', () => {
    const out = normalisePayload([{
      code: 'PQ3', events: [], error: { codError: 1, desError: 'no' },
    }], 'poll');

    // Correos did answer about this code. Leaving it out of codesSeen would
    // have the batch spend a second request getting the same error.
    expect(out.codesSeen).toEqual(['PQ3']);
  });

  it('accepts codError as a string, because some of their feeds send one', () => {
    const out = normalisePayload([{
      code: 'PQ4', events: [], error: { codError: '12', desError: 'mal' },
    }], 'poll');

    expect(out.errors[0].codError).toBe(12);
  });

  it('treats codError 0 as success', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');
    expect(out.errors).toEqual([]);
  });

  it('ignores the events of a shipment Correos is reporting an error for', () => {
    const out = normalisePayload([{
      code: 'PQ5',
      events: [v2Event('A010000V', 'Admitido.')],
      error: { codError: 9, desError: 'algo' },
    }], 'poll');

    // Whatever is in there is about a lookup that did not work.
    expect(out.events).toEqual([]);
    expect(out.errors).toHaveLength(1);
  });

  it('becomes a failed lookup, not a parcel with no news', async () => {
    const { fetchImpl } = stub([{
      body: [{ code: 'PQ6', events: [], error: { codError: 1, desError: 'Envío no encontrado' } }],
    }]);

    const r = await client(fetchImpl).lookup('PQ6');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // HTTP was fine. Saying 404 or 500 here would send somebody to look at the
    // gateway instead of at the code.
    expect(r.status).toBe(200);
    expect(r.error).toContain('Envío no encontrado');
    expect(r.retryable).toBe(false);
  });

  it('fails only the code it belongs to, inside a batch', async () => {
    const { fetchImpl } = stub([{
      body: [
        v2Shipment('PQ7', [v2Event('A010000V', 'Admitido.')]),
        { code: 'PQ8', events: [], error: { codError: 1, desError: 'Envío no encontrado' } },
      ],
    }]);

    const res = await client(fetchImpl).lookupMany(['PQ7', 'PQ8']);

    expect(res.byCode.get('PQ7')?.ok).toBe(true);
    expect(res.byCode.get('PQ8')?.ok).toBe(false);
    // One request: the bad code was answered, so it is not re-asked singly.
    expect(res.requests).toBe(1);
    expect(res.notReached).toEqual([]);
  });
});

/* ========================================================================== */

describe('batch coverage keyed on `code`', () => {
  it('recognises a batch answer in the v2 shape', async () => {
    const { urls, fetchImpl } = stub([{
      body: [
        v2Shipment('PQA', [v2Event('A010000V', 'Admitido.', 'EN CAMINO')]),
        v2Shipment('PQB', [v2Event('P040000V', 'Clasificado', 'EN CAMINO')]),
      ],
    }]);

    const res = await client(fetchImpl).lookupMany(['PQA', 'PQB']);

    expect(res.requests).toBe(1);
    expect(res.mode).toBe('comma');
    expect(urls[0]).toContain('/search/PQA,PQB');
    expect(res.byCode.get('PQA')?.ok).toBe(true);
    expect(res.byCode.get('PQB')?.ok).toBe(true);
  });

  it('gives each code only its own events', async () => {
    const { fetchImpl } = stub([{
      body: [
        v2Shipment('PQA', [v2Event('A010000V', 'Admitido.')]),
        v2Shipment('PQB', [v2Event('P040000V', 'Clasificado'), v2Event('A090000V', 'Prerregistrado')]),
      ],
    }]);

    const res = await client(fetchImpl).lookupMany(['PQA', 'PQB']);

    const a = res.byCode.get('PQA');
    const b = res.byCode.get('PQB');
    expect(a?.ok && a.outcome.events).toHaveLength(1);
    expect(b?.ok && b.outcome.events).toHaveLength(2);
  });

  it('asks singly for a code the v2 answer left out', async () => {
    // Before `code` was read, EVERY batch looked like this — nothing matched,
    // so nothing was covered, and the sweep would have marked the lot as
    // checked with no events.
    const { fetchImpl } = stub([
      { body: [v2Shipment('PQA', [v2Event('A010000V', 'Admitido.')])] },
      { body: [v2Shipment('PQB', [v2Event('P040000V', 'Clasificado')])] },
    ]);

    const res = await client(fetchImpl).lookupMany(['PQA', 'PQB']);

    expect(res.requests).toBe(2);
    expect(res.byCode.get('PQB')?.ok).toBe(true);
  });
});

/* ========================================================================== */

describe('the three confirmed event codes', () => {
  it('are the ones seen in real traffic', () => {
    expect(knownCodes().sort()).toEqual(['A010000V', 'A090000V', 'P040000V']);
  });

  it.each([
    ['A090000V', 'Prerregistrado', 'created'],
    ['A010000V', 'Admitido.', 'accepted'],
    ['P040000V', 'Clasificado', 'in_transit'],
  ])('%s (%s) → %s', (code, desc, state) => {
    const match = matchCorreosEvent(code, desc, 'EN CAMINO');
    expect(match).toEqual({ state, via: 'code' });
    // Matched by code, so there is nothing for a human to add.
    expect(needsReview(code, desc, 'EN CAMINO')).toBe(false);
  });

  it('maps the real response to a state for every event', () => {
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    expect(out.events.map((e) => mapCorreosEvent(e.eventCode, e.eventDesc, e.phase)))
      .toEqual(['created', 'accepted', 'in_transit']);
    // And nothing from it needs a human.
    expect(unmappedIn(out)).toEqual([]);
  });
});

describe('trailing punctuation', () => {
  it('matches "Admitido." the way Correos sends it', () => {
    expect(normaliseDesc('Admitido.')).toBe('admitido');
    expect(mapCorreosEvent(null, 'Admitido.')).toBe('accepted');
  });

  it('matches it with trailing whitespace too', () => {
    // The period strip is anchored at the end of the string, so with a trailing
    // space the `$` sat after the space and the period survived. Collapsing
    // whitespace first is the fix, and this is the case that proves it.
    expect(normaliseDesc('Admitido. ')).toBe('admitido');
    expect(mapCorreosEvent(null, 'Admitido. ')).toBe('accepted');
    expect(mapCorreosEvent(null, '  Entregado.  ')).toBe('delivered');
  });

  it.each([';', ':', ',', '...', '.,'])('strips a trailing "%s"', (p) => {
    expect(mapCorreosEvent(null, `En reparto${p}`)).toBe('out_for_delivery');
  });

  it('does not strip punctuation from the middle', () => {
    expect(normaliseDesc('Intento de entrega fallido - ausente.')).toBe('intento de entrega fallido - ausente');
  });
});

describe('the phase, as a last resort', () => {
  it.each([
    ['PRE-ADMISIÓN', 'created'],
    ['EN CAMINO', 'in_transit'],
    ['EN ENTREGA', 'out_for_delivery'],
    ['ENTREGADO', 'delivered'],
  ])('%s → %s when the code and the wording are both unknown', (phase, state) => {
    const match = matchCorreosEvent('ZZ999', 'Una cosa que no conocemos', phase);
    expect(match).toEqual({ state, via: 'phase' });
  });

  it('maps SIN FASE to nothing, because it is not information', () => {
    expect(matchCorreosEvent('ZZ999', 'Desconocido', 'SIN FASE')).toBeNull();
  });

  it('keeps the hyphen in PRE-ADMISIÓN', () => {
    // normaliseDesc flattens dashes to " - " for descriptions, which would
    // spell this `pre - admision`. Phases get their own normaliser.
    expect(normalisePhase('PRE-ADMISIÓN')).toBe('pre-admision');
    expect(normalisePhase('pre-admision')).toBe('pre-admision');
  });

  it('never overrules a known code', () => {
    // A090000V is `created`; the phase says EN CAMINO. The code wins.
    expect(matchCorreosEvent('A090000V', 'Prerregistrado', 'EN CAMINO'))
      .toEqual({ state: 'created', via: 'code' });
  });

  it('never overrules a known wording', () => {
    expect(matchCorreosEvent('ZZ999', 'Entregado', 'EN CAMINO'))
      .toEqual({ state: 'delivered', via: 'description' });
  });

  it('still sends a phase-only match to the review queue', () => {
    // The phase keeps the parcel moving. It does not mean we understand the
    // event, and collecting the codes we do not have is what the queue is for.
    expect(needsReview('ZZ999', 'Una cosa nueva', 'EN CAMINO')).toBe(true);

    const out = normalisePayload(
      [v2Shipment('PQZ', [v2Event('ZZ999', 'Una cosa nueva', 'EN CAMINO')])],
      'poll',
    );
    expect(mapCorreosEvent('ZZ999', 'Una cosa nueva', 'EN CAMINO')).toBe('in_transit');
    expect(unmappedIn(out)).toHaveLength(1);
  });

  it('sends an event with no phase at all to the review queue', () => {
    const out = normalisePayload(
      [v2Shipment('PQY', [v2Event('ZZ998', 'Otra cosa nueva', null)])],
      'poll',
    );
    expect(unmappedIn(out)).toHaveLength(1);
    expect(mapCorreosEvent('ZZ998', 'Otra cosa nueva', null)).toBeNull();
  });
});

/* ========================================================================== */

describe('end to end, against the database', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeDb(); });

  it('moves a real parcel to the state its newest event says', async () => {
    // The consequence of the parse bug, stated as a test: every parcel stayed
    // at `created` while Correos was telling us it had been accepted and
    // classified, and the only sign was a deposit window quietly running out.
    const fix = await makeShipment({ shippingCode: REAL_CODE });

    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');
    for (const ev of out.events) await ingestEvent(ev);

    const [ship] = await getDb().select({ state: shipments.state })
      .from(shipments).where(eq(shipments.id, fix.shipmentId));

    expect(ship.state).toBe('in_transit');
  });

  it('stores all three events with their seconds intact', async () => {
    await makeShipment({ shippingCode: REAL_CODE });

    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');
    for (const ev of out.events) await ingestEvent(ev);

    const rows = await getDb().select({
      eventCode: shipmentEvents.eventCode,
      occurredAt: shipmentEvents.occurredAt,
      mappedState: shipmentEvents.mappedState,
    }).from(shipmentEvents).orderBy(asc(shipmentEvents.occurredAt));

    expect(rows.map((r) => r.eventCode)).toEqual(['A090000V', 'A010000V', 'P040000V']);
    expect(rows.map((r) => r.mappedState)).toEqual(['created', 'accepted', 'in_transit']);
    // 20 seconds apart. `UNIQUE(shipment_id, event_code, occurred_at)` is the
    // dedupe key, so losing the seconds would start merging distinct events.
    expect(rows[2].occurredAt.getTime() - rows[1].occurredAt.getTime()).toBe(20_000);
  });

  it('queues nothing for review, because all three codes are known', async () => {
    await makeShipment({ shippingCode: REAL_CODE });

    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');
    for (const ev of out.events) await ingestEvent(ev);

    const queued = await getDb().select({ eventCode: eventReviewQueue.eventCode })
      .from(eventReviewQueue);

    expect(queued).toEqual([]);
  });

  it('queues a phase-only event even though it changed the state', async () => {
    const fix = await makeShipment({ shippingCode: 'PQPHASE1ES' });

    const out = normalisePayload(
      [v2Shipment('PQPHASE1ES', [v2Event('ZZ999', 'Una cosa nueva', 'EN ENTREGA')])],
      'poll',
    );
    for (const ev of out.events) await ingestEvent(ev);

    const [ship] = await getDb().select({ state: shipments.state })
      .from(shipments).where(eq(shipments.id, fix.shipmentId));
    const queued = await getDb().select({ eventCode: eventReviewQueue.eventCode })
      .from(eventReviewQueue);

    // Both at once, which is the point: the parcel keeps moving on the strength
    // of the phase, and the unknown code still reaches a human.
    expect(ship.state).toBe('out_for_delivery');
    expect(queued.map((q) => q.eventCode)).toEqual(['ZZ999']);
  });

  it('ingests the same response twice without duplicating anything', async () => {
    await makeShipment({ shippingCode: REAL_CODE });
    const out = normalisePayload(REAL_SEARCH_RESPONSE, 'poll');

    for (const ev of out.events) await ingestEvent(ev);
    for (const ev of out.events) await ingestEvent(ev);

    const rows = await getDb().select({ id: shipmentEvents.id }).from(shipmentEvents);
    expect(rows).toHaveLength(3);
  });
});
