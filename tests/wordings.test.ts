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
