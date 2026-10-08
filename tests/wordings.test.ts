import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { eventReviewQueue, shipmentEvents, shipments } from '@/db/schema';
import {
  matchCorreosEvent, mapCorreosEvent, needsReview, normaliseDesc,
} from '@/lib/carriers/correos/state-map';
import { remapKnownEvents } from '@/lib/shipments/remap';
import { parcelsView } from '@/lib/views/parcels';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The wordings and codes Correos actually sent on 7 October, and the replay
 * that moves the parcels already carrying them.
 *
 * Every string here is a verbatim capture, including the full stop in the
 * middle of "Intento de entrega. Ausente" — which is the whole reason that one
 * did not map. `normaliseDesc` strips trailing punctuation only, so the key is
 * "intento de entrega. ausente" and a key written without the stop matches
 * nothing. Writing the test against the string as received rather than against
 * the key is the point: a tidied-up fixture would have passed while the live
 * parcel stayed in the wrong tab.
 */

const AT_OFFICE = { code: 'H01I350V', desc: 'A disposición del destinatario', phase: 'EN ENTREGA' };
const RETURNING = { code: 'L03D320R', desc: 'Finalizado plazo retirada', phase: 'DEVOLUCION' };
/*
 * The code on the failed-delivery event is not in `BY_CODE`: the payload we
 * have for it was summarised rather than captured, so the real code is not
 * confirmed and nothing guesses it. The placeholder here stands in for "a code
 * we do not recognise", which is what makes the test prove the point — the
 * parcel has to reach `failed` on the wording alone.
 */
const FAILED = { code: 'UNKNOWN-CODE', desc: 'Intento de entrega. Ausente', phase: 'EN ENTREGA' };

/**
 * The codes read out of `shipment_events` and `event_review_queue` in
 * production, with the wordings they arrived under.
 *
 * `H01R420V` is the real code for "Intento de entrega. Ausente", which the
 * block above says was missing: `remapKnownEvents` wrote it onto the
 * review-queue row it resolved by wording, and this is it. `FAILED` keeps its
 * placeholder because the test it is used in is about the wording standing on
 * its own when the code is unknown — which is still what happens to any code
 * Correos has not shown us yet.
 */
const REAL = [
  { code: 'H01R420V', desc: 'Intento de entrega. Ausente', phase: 'EN ENTREGA', state: 'failed' },
  { code: 'L03D045R', desc: 'En proceso de devolución', phase: 'DEVOLUCION', state: 'returning' },
  {
    code: 'H01R421V',
    desc: 'Dirección Incorrecta. Se procede a remitir el envio a la oficina de referencia',
    phase: 'EN ENTREGA',
    state: 'bad_address',
  },
] as const;

/**
 * Codes that arrived with them and are deliberately NOT mapped.
 *
 * Every one is waiting on an answer from Correos, because the words alone do
 * not settle what we should do. Two are near-misses for wordings we DO map and
 * are the reason this list is a test rather than a comment:
 *
 *   "Realizado intento de entrega" says an attempt was made and not whether it
 *   succeeded. Reading it as a failure would start the post-failure ladder on
 *   parcels that were delivered.
 *
 *   "Alta en la unidad de reparto" used to be on this list, one word away from
 *   a spelling we DID map, and the two disagreed. Correos settled it: both are
 *   `out_for_delivery` now, and the pair is tested below rather than here.
 */
const IN_REVIEW = [
  { code: 'H01R424V', desc: 'Realizado intento de entrega' },
  { code: 'H06P010V', desc: 'En proceso de entrega' },
  { code: 'H06P050V', desc: 'En proceso de entrega' },
  { code: 'M010090R', desc: 'Envío a estacionar' },
  { code: 'M01E020R', desc: 'Envío a estacionar' },
  { code: 'M01E320R', desc: 'Estacionado' },
  { code: 'M02E340V', desc: 'Desestacionado' },
  { code: 'M02E360V', desc: 'Desestacionado' },
  { code: 'R010751V', desc: 'Entrega modificada' },
] as const;

beforeEach(resetDb);
afterAll(closeDb);

describe('the wordings as received', () => {
  it('maps each one to its state', () => {
    expect(mapCorreosEvent(null, AT_OFFICE.desc, AT_OFFICE.phase)).toBe('at_office');
    expect(mapCorreosEvent(null, RETURNING.desc, RETURNING.phase)).toBe('returning');
    expect(mapCorreosEvent(null, FAILED.desc, FAILED.phase)).toBe('failed');
  });

  it('keeps the full stop in the middle of the failed-delivery key', () => {
    expect(normaliseDesc(FAILED.desc)).toBe('intento de entrega. ausente');
  });

  it('maps the long expandedText wording of the return as well', () => {
    expect(mapCorreosEvent(
      null,
      'Devolución del envío por finalización de plazo de retirada',
      null,
    )).toBe('returning');
  });

  it('maps H01I350V and L03D320R by their code, with no wording at all', () => {
    expect(matchCorreosEvent(AT_OFFICE.code, 'something nobody has seen', null))
      .toEqual({ state: 'at_office', via: 'code' });
    expect(matchCorreosEvent(RETURNING.code, 'something nobody has seen', null))
      .toEqual({ state: 'returning', via: 'code' });
  });

  it('rescues an unknown return wording from the DEVOLUCION phase', () => {
    expect(matchCorreosEvent(null, 'Trámite aduanero de devolución', 'DEVOLUCION'))
      .toEqual({ state: 'returning', via: 'phase' });
  });

  it('still lets a known code or wording beat the phase', () => {
    // The phase says it is going back; the code says it is at the counter.
    // The code wins, because the phase is the weakest signal we have.
    expect(matchCorreosEvent(AT_OFFICE.code, 'whatever', 'DEVOLUCION'))
      .toEqual({ state: 'at_office', via: 'code' });
    expect(matchCorreosEvent(null, 'Entregado', 'DEVOLUCION'))
      .toEqual({ state: 'delivered', via: 'description' });
  });

  it('keeps a phase-only match in the review queue', () => {
    expect(needsReview(null, 'Trámite aduanero de devolución', 'DEVOLUCION')).toBe(true);
    expect(needsReview(RETURNING.code, RETURNING.desc, RETURNING.phase)).toBe(false);
  });

  it('leaves Desestacionado and Entrega modificada unmapped', () => {
    for (const desc of ['Desestacionado', 'Entrega modificada']) {
      expect(mapCorreosEvent(null, desc, null)).toBeNull();
      expect(needsReview(null, desc, null)).toBe(true);
    }
  });
});

describe('the codes read out of production', () => {
  it.each(REAL)('$code ($desc) → $state, by code', ({ code, desc, phase, state }) => {
    expect(matchCorreosEvent(code, desc, phase)).toEqual({ state, via: 'code' });
    expect(needsReview(code, desc, phase)).toBe(false);
  });

  it.each(REAL)('$code also maps on its wording alone', ({ desc, phase, state }) => {
    // The code is the stable key and the wording is the one we see first, so
    // both are kept: a code Correos renames still lands on the right state,
    // and a wording that turns up under a new code does too.
    expect(mapCorreosEvent(null, desc, phase)).toBe(state);
  });

  it('reads the full wrong-address sentence, not just the first two words', () => {
    // "Dirección incorrecta" on its own was already mapped. The sentence
    // Correos actually sends is longer and matches none of the short keys.
    const full = 'Dirección Incorrecta. Se procede a remitir el envio a la oficina de referencia';
    expect(normaliseDesc(full))
      .toBe('direccion incorrecta. se procede a remitir el envio a la oficina de referencia');
    expect(mapCorreosEvent(null, full, null)).toBe('bad_address');
    // And with the accent Correos puts on "envío", which normalising strips.
    expect(mapCorreosEvent(null, full.replace('envio', 'envío'), null)).toBe('bad_address');
  });

  it.each(IN_REVIEW)('$code ($desc) stays in review, whatever its phase', ({ code, desc }) => {
    // Under no phase, and under both phases that now map — a phase match is
    // enough to keep a parcel moving and never enough to say we recognise the
    // event, which is the whole point of the queue.
    for (const phase of [null, 'EN ENTREGA', 'DEVOLUCION', 'EN CAMINO']) {
      expect(needsReview(code, desc, phase), `${code} with phase ${phase}`).toBe(true);
      const match = matchCorreosEvent(code, desc, phase);
      expect(match?.via, `${code} with phase ${phase}`).not.toBe('code');
      expect(match?.via, `${code} with phase ${phase}`).not.toBe('description');
    }
  });

  it('keeps "Realizado intento de entrega" away from the failed-delivery keys', () => {
    // It says an attempt was made and not whether it succeeded. Reading it as
    // a failure would start the post-failure ladder on delivered parcels.
    expect(mapCorreosEvent(null, 'Realizado intento de entrega', null)).toBeNull();
    // While the four wordings that do mean a failure still map.
    for (const desc of [
      'Intento de entrega fallido — ausente',
      'Intento de entrega fallido',
      'Destinatario ausente',
      'Intento de entrega. Ausente',
    ]) {
      expect(mapCorreosEvent(null, desc, null), desc).toBe('failed');
    }
  });

  it('gives both "alta en … unidad de reparto" spellings the same answer', () => {
    /*
     * These used to disagree, and a round was spent explaining why they had to:
     * the shorter spelling came off Correos' public web tracker and was read as
     * `in_transit`, the longer one is what their API sends and was left in the
     * review queue. One event, two keys, two answers.
     *
     * Correos' own tracker groups it under OUT FOR DELIVERY — "Your shipment
     * has arrived at the unit responsible for its delivery" — so both spellings
     * and the code now land there together. The reason this is a test and not
     * just a table entry is that the two keys are one word apart and nothing
     * else would notice them drifting again.
     */
    expect(mapCorreosEvent(null, 'Alta en unidad de reparto', null)).toBe('out_for_delivery');
    expect(mapCorreosEvent(null, 'Alta en la unidad de reparto', null)).toBe('out_for_delivery');
    expect(matchCorreosEvent('G01L010V', 'whatever they send next', null))
      .toEqual({ state: 'out_for_delivery', via: 'code' });
    expect(needsReview('G01L010V', 'Alta en la unidad de reparto', 'EN ENTREGA')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

interface StoredEvent {
  code: string;
  desc: string;
  phase: string | null;
  /** What the OLD map made of it. This is the state being corrected. */
  mappedState: string | null;
  at: Date;
}

/** An event row exactly as the sweep would have written it before the fix. */
async function store(shipmentId: string, events: StoredEvent[]): Promise<void> {
  await getDb().insert(shipmentEvents).values(events.map((e) => ({
    shipmentId,
    eventCode: e.code,
    eventDesc: e.desc,
    occurredAt: e.at,
    source: 'poll' as const,
    mappedState: e.mappedState,
    // The phase lives on the payload, which is where the remap reads it from.
    rawPayload: { eventCode: e.code, summaryText: e.desc, phaseDes: e.phase },
  })));
}

async function queueReview(code: string, desc: string): Promise<void> {
  await getDb().insert(eventReviewQueue).values({
    eventCode: code, eventDesc: desc, samplePayload: {},
  });
}

async function stateOf(id: string): Promise<string> {
  const [row] = await getDb().select({ state: shipments.state }).from(shipments)
    .where(eq(shipments.id, id)).limit(1);
  return row.state;
}

async function tabIds(tab: string): Promise<string[]> {
  const view = await parcelsView({ status: tab, at: new Date('2026-10-07T09:00:00Z') });
  return view.rows.map((r) => r.id);
}

describe('moving the parcels that already carry these events', () => {
  it('sends the finished-window parcel to Coming back, out of the office tabs', async () => {
    const f = await makeShipment({ shippingCode: 'PQ21627000ES', state: 'at_office' });
    await store(f.shipmentId, [
      { ...AT_OFFICE, mappedState: 'at_office', at: new Date('2026-09-20T10:00:00Z') },
      // Nothing recognised it, so it changed no state: the parcel sat at the
      // office with a countdown nobody could act on.
      { ...RETURNING, mappedState: null, at: new Date('2026-10-05T10:00:00Z') },
    ]);
    await queueReview(RETURNING.code, RETURNING.desc);

    const out = await remapKnownEvents();

    expect(out.events).toBe(1);
    expect(out.moved).toBe(1);
    expect(await stateOf(f.shipmentId)).toBe('returning');
    expect(await tabIds('returning')).toContain(f.shipmentId);
    expect(await tabIds('at_office')).not.toContain(f.shipmentId);
    expect(await tabIds('missed_delivery')).not.toContain(f.shipmentId);
  });

  it('sends the absent-customer parcel to Failed delivery', async () => {
    const f = await makeShipment({ shippingCode: 'PQ22247000ES', state: 'out_for_delivery' });
    await store(f.shipmentId, [
      // What the phase fallback made of it: out for delivery, so neither the
      // Failed delivery tab nor the post-failure ladder ever saw it.
      { ...FAILED, mappedState: 'out_for_delivery', at: new Date('2026-10-05T12:00:00Z') },
    ]);

    await remapKnownEvents();

    expect(await stateOf(f.shipmentId)).toBe('failed');
    expect(await tabIds('failed')).toContain(f.shipmentId);
  });

  it('resolves the review-queue rows the map now answers, and no others', async () => {
    const f = await makeShipment({ shippingCode: 'PQ21627001ES', state: 'at_office' });
    await store(f.shipmentId, [
      { ...RETURNING, mappedState: null, at: new Date('2026-10-05T10:00:00Z') },
      { code: 'Z09Z999V', desc: 'Desestacionado', phase: null, mappedState: null, at: new Date('2026-10-06T10:00:00Z') },
    ]);
    await queueReview(RETURNING.code, RETURNING.desc);
    await queueReview('Z09Z999V', 'Desestacionado');

    const out = await remapKnownEvents();

    expect(out.resolved).toEqual([`${RETURNING.code} → returning`]);

    const rows = await getDb().select().from(eventReviewQueue);
    const answered = rows.find((r) => r.eventDesc === RETURNING.desc);
    const stillOpen = rows.find((r) => r.eventDesc === 'Desestacionado');
    expect(answered?.resolvedAs).toBe('returning');
    expect(answered?.resolvedAt).not.toBeNull();
    expect(stillOpen?.resolvedAt).toBeNull();
  });

  it('leaves a phase-only rescue in the review queue', async () => {
    const f = await makeShipment({ shippingCode: 'PQ30000001ES', state: 'at_office' });
    await store(f.shipmentId, [
      { code: 'Q01Q000V', desc: 'Trámite aduanero de devolución', phase: 'DEVOLUCION', mappedState: null, at: new Date('2026-10-06T10:00:00Z') },
    ]);
    await queueReview('Q01Q000V', 'Trámite aduanero de devolución');

    const out = await remapKnownEvents();

    expect(out.moved).toBe(1);
    expect(await stateOf(f.shipmentId)).toBe('returning');
    expect(out.resolved).toEqual([]);
    const [row] = await getDb().select().from(eventReviewQueue);
    expect(row.resolvedAt).toBeNull();
  });

  it('changes nothing on a second run', async () => {
    const f = await makeShipment({ shippingCode: 'PQ21627002ES', state: 'at_office' });
    await store(f.shipmentId, [
      { ...RETURNING, mappedState: null, at: new Date('2026-10-05T10:00:00Z') },
    ]);

    await remapKnownEvents();
    const again = await remapKnownEvents();

    expect(again.events).toBe(0);
    expect(again.parcels).toBe(0);
    expect(again.moved).toBe(0);
    expect(await stateOf(f.shipmentId)).toBe('returning');
  });

  it('moves the parcels carrying the three codes read out of production', async () => {
    /*
     * Each one as it sits in the database today: an event whose code we did
     * not recognise, rescued by its phase or by nothing at all. The states
     * below are what the operator is looking at right now, which is the point
     * — nothing happens to these parcels until the map is replayed, and for a
     * parcel on its way back Correos has nothing further to say.
     */
    const cases = [
      { ship: 'PQ94000001ES', was: 'out_for_delivery', ev: REAL[0], tab: 'failed' },
      { ship: 'PQ94000002ES', was: 'at_office', ev: REAL[1], tab: 'returning' },
      { ship: 'PQ94000003ES', was: 'out_for_delivery', ev: REAL[2], tab: 'bad_address' },
    ] as const;

    const made: Record<string, string> = {};
    for (const c of cases) {
      const f = await makeShipment({ shippingCode: c.ship, state: c.was });
      made[c.ship] = f.shipmentId;
      await store(f.shipmentId, [{
        code: c.ev.code,
        desc: c.ev.desc,
        phase: c.ev.phase,
        // What the phase fallback made of it, or null where nothing matched.
        mappedState: c.was === 'out_for_delivery' ? 'out_for_delivery' : null,
        at: new Date('2026-10-06T12:00:00Z'),
      }]);
      await queueReview(c.ev.code, c.ev.desc);
    }

    const out = await remapKnownEvents();

    expect(out.moved).toBe(3);
    expect(out.resolved.sort()).toEqual([
      'H01R420V → failed',
      'H01R421V → bad_address',
      'L03D045R → returning',
    ]);

    for (const c of cases) {
      expect(await stateOf(made[c.ship]), c.ev.code).toBe(c.ev.state);
      expect(await tabIds(c.tab), c.ev.code).toContain(made[c.ship]);
    }

    // And every review row they came from is answered.
    const rows = await getDb().select().from(eventReviewQueue);
    expect(rows.filter((r) => r.resolvedAt === null)).toEqual([]);
  });

  it('leaves the ten unanswered codes exactly where they are', async () => {
    const f = await makeShipment({ shippingCode: 'PQ94000004ES', state: 'in_transit' });
    await store(f.shipmentId, IN_REVIEW.map((e, i) => ({
      code: e.code,
      desc: e.desc,
      phase: 'EN ENTREGA',
      mappedState: 'out_for_delivery',
      at: new Date(`2026-10-0${(i % 6) + 1}T0${i % 9}:00:00Z`),
    })));
    for (const e of IN_REVIEW) await queueReview(e.code, e.desc);

    const out = await remapKnownEvents();

    expect(out.events).toBe(0);
    expect(out.resolved).toEqual([]);
    const rows = await getDb().select().from(eventReviewQueue);
    expect(rows).toHaveLength(IN_REVIEW.length);
    expect(rows.every((r) => r.resolvedAt === null)).toBe(true);
  });

  it('never un-maps an event the current map does not recognise', async () => {
    const f = await makeShipment({ shippingCode: 'PQ30000002ES', state: 'delivered' });
    await store(f.shipmentId, [
      // A state written by a mapping that no longer exists. Replaying must not
      // wipe it: a stale label is a smaller failure than a live parcel
      // silently losing the only state anybody recorded for it.
      { code: 'OLD001V', desc: 'Una frase que ya no está en la tabla', phase: null, mappedState: 'delivered', at: new Date('2026-10-01T10:00:00Z') },
    ]);

    await remapKnownEvents();

    const [ev] = await getDb().select().from(shipmentEvents);
    expect(ev.mappedState).toBe('delivered');
  });
});
