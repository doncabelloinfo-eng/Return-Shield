import { z } from 'zod';
import { needsReview } from './state-map';
import type { IncomingEvent } from '@/lib/shipments/ingest';

/**
 * Correos' payloads, turned into events we can store.
 *
 * Their ShipmentTrack&TracePush body and the trackpub search response describe
 * the same thing in different shapes, and both have optional fields that are
 * present in the swagger and absent in real traffic. So the schemas below are
 * deliberately loose: anything we can identify a parcel and a moment from is
 * good enough, and everything else is kept on the raw payload.
 *
 * Nothing in here throws on unexpected input. A payload we cannot read is
 * reported to the caller, which stores it and moves on.
 *
 * The trackpub v2 field names were confirmed against a real `/search` response
 * on 6 October and are nothing like the push feed's: the tracking code is
 * `code`, events are `events[]`, the description is `summaryText` with
 * `expandedText` underneath it, and the time is `eventHours`. Until then this
 * file read none of them, so every real lookup parsed to zero events and the
 * Settings test said "Correos knows the code but has no events for it yet"
 * about parcels with three.
 */

const loose = z.object({}).passthrough();

/**
 * One event as Correos describes it, in either feed.
 *
 * Every field is `.nullish()` rather than `.optional()`. Their real response
 * sends explicit nulls for everything it has nothing to say about — `unit`,
 * `location`, `phase` and a dozen others were all null in the captured sample
 * — and `z.string().optional()` rejects null, which would fail the parse on a
 * perfectly good payload and lose the whole batch.
 */
const EventSchema = loose.extend({
  // The code. `eventCode` is the trackpub v2 spelling, e.g. "A010000V".
  codEvento: z.string().nullish(),
  codigoEvento: z.string().nullish(),
  eventCode: z.string().nullish(),
  // The description. `summaryText` is the short one trackpub v2 sends
  // ("Admitido."); `expandedText` is its longer sibling and stands in when the
  // summary is missing.
  summaryText: z.string().nullish(),
  expandedText: z.string().nullish(),
  desEvento: z.string().nullish(),
  descripcionEvento: z.string().nullish(),
  eventDescription: z.string().nullish(),
  // The date, "DD/MM/YYYY".
  fecEvento: z.string().nullish(),
  fechaEvento: z.string().nullish(),
  eventDate: z.string().nullish(),
  // The time. `eventHours` is trackpub v2's, and carries seconds: "16:17:03".
  horEvento: z.string().nullish(),
  horaEvento: z.string().nullish(),
  eventTime: z.string().nullish(),
  eventHours: z.string().nullish(),
  // The coarse delivery phase: "PRE-ADMISIÓN", "EN CAMINO", … Weakest signal
  // we have, and the last one the state mapper tries.
  phaseDes: z.string().nullish(),
  phase: z.string().nullish(),
  // Office and handling-unit fields. See `officeOf` for which are mapped.
  codOficina: z.string().nullish(),
  codigoOficina: z.string().nullish(),
  desOficina: z.string().nullish(),
  nombreOficina: z.string().nullish(),
  dirOficina: z.string().nullish(),
  direccionOficina: z.string().nullish(),
  codired: z.string().nullish(),
  unit: z.string().nullish(),
  location: z.string().nullish(),
  sectionCode: z.string().nullish(),
});

/** Correos' per-shipment result code. `codError: 0` means the lookup was fine. */
const ErrorSchema = loose.extend({
  codError: z.union([z.number(), z.string()]).nullish(),
  desError: z.string().nullish(),
});

const ShipmentSchema = loose.extend({
  // `code` is the trackpub v2 spelling and the one real traffic uses.
  code: z.string().nullish(),
  codEnvio: z.string().nullish(),
  codigoEnvio: z.string().nullish(),
  shippingCode: z.string().nullish(),
  eventos: z.array(EventSchema).nullish(),
  events: z.array(EventSchema).nullish(),
  error: ErrorSchema.nullish(),
  // Kept on the stored payload, used by nothing yet. `reference1` is the
  // Shopify order number ("#22430"), and `dateExpiration` may turn out to be
  // the office-hold deadline — which is the number this whole system is built
  // around, so it is worth having the evidence before trusting it.
  reference1: z.unknown().optional(),
  reference3: z.unknown().optional(),
  expeditionCode: z.unknown().optional(),
  deliveryDate: z.unknown().optional(),
  dateExpiration: z.unknown().optional(),
  dateCalculated: z.unknown().optional(),
  weight: z.unknown().optional(),
});

const PayloadSchema = z.union([
  ShipmentSchema,
  z.array(ShipmentSchema),
  loose.extend({ envios: z.array(ShipmentSchema) }),
  loose.extend({ shipments: z.array(ShipmentSchema) }),
]);

/**
 * Correos saying something went wrong with one specific code, inside an
 * otherwise successful 200.
 */
export interface ShipmentError {
  code: string;
  codError: number;
  desError: string;
}

export interface NormaliseOutcome {
  events: IncomingEvent[];
  /** Things we could not read. Kept so a human can look at them. */
  problems: string[];
  /**
   * Per-shipment `error` blocks with a non-zero `codError`.
   *
   * These arrive with HTTP 200, so nothing above this layer would notice them.
   * A caller turns one into a failed lookup for that code rather than letting
   * a parcel be stamped as freshly checked on the strength of an error
   * message.
   */
  errors: ShipmentError[];
  /**
   * Every tracking code the payload talked about, whether or not it had any
   * events. This is what tells a batch lookup which of the codes it asked
   * about were actually answered — a parcel with no events yet is a different
   * thing from a parcel the response left out, and conflating them would stamp
   * parcels as checked that nobody checked.
   */
  codesSeen: string[];
}

export function normalisePayload(
  payload: unknown,
  source: 'push' | 'poll',
): NormaliseOutcome {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      events: [],
      problems: ['payload did not look like a Correos tracking body'],
      errors: [],
      codesSeen: [],
    };
  }

  const shipments = collectShipments(parsed.data);
  const events: IncomingEvent[] = [];
  const problems: string[] = [];
  const errors: ShipmentError[] = [];
  const codesSeen = new Set<string>();

  for (const s of shipments) {
    const shippingCode = firstString(s.code, s.codEnvio, s.codigoEnvio, s.shippingCode)
      ?.trim().toUpperCase();
    if (!shippingCode) { problems.push('a shipment with no tracking code'); continue; }

    // Added even when the shipment carries an error. Correos DID answer about
    // this code, so a batch must not go and ask again — it would get the same
    // error and spend a request learning nothing.
    codesSeen.add(shippingCode);

    const failure = errorOf(s.error);
    if (failure) {
      errors.push({ code: shippingCode, ...failure });
      problems.push(`${shippingCode}: Correos returned error ${failure.codError}`
        + `${failure.desError ? ` — ${failure.desError}` : ''}`);
      // No events are trusted from a shipment Correos is reporting an error
      // for: whatever is in there is about a lookup that did not work.
      continue;
    }

    const list = s.eventos ?? s.events ?? [];
    if (!list.length) problems.push(`${shippingCode}: no events in the payload`);

    // The shipment's own fields, carried onto every one of its events so the
    // stored payload is self-contained. Deliberately a fixed list rather than
    // the whole shipment object: that object holds the events array, and
    // copying it onto each event would store a hundred events a hundred times.
    const shipmentContext = contextOf(s);

    for (const e of list) {
      const desc = firstString(
        e.summaryText, e.desEvento, e.descripcionEvento, e.eventDescription, e.expandedText,
      )?.trim();
      if (!desc) { problems.push(`${shippingCode}: an event with no description`); continue; }

      const occurredAt = parseCorreosMoment(
        firstString(e.fecEvento, e.fechaEvento, e.eventDate),
        firstString(e.horEvento, e.horaEvento, e.eventTime, e.eventHours),
      );
      if (!occurredAt) { problems.push(`${shippingCode}: could not read the date on "${desc}"`); continue; }

      // The code is the dedupe key. When Correos does not send one, the
      // description stands in — two different events at the same instant with
      // the same wording are the same event whatever it is called.
      const eventCode = firstString(e.codEvento, e.codigoEvento, e.eventCode)?.trim()
        ?? `desc:${desc.slice(0, 60)}`;

      const office = officeOf(e);

      events.push({
        shippingCode,
        eventCode,
        eventDesc: desc,
        phase: firstString(e.phaseDes, e.phase) ?? null,
        occurredAt,
        source,
        officeCode: office.code,
        officeName: office.name,
        officeAddress: office.address,
        rawPayload: { ...e, shipment: shipmentContext },
      });
    }
  }

  return { events, problems, errors, codesSeen: [...codesSeen] };
}

/**
 * Events a human should still look at.
 *
 * Includes events the coarse `phaseDes` rescued: the phase is enough to keep
 * the parcel moving and not enough to say we understand the event, and the
 * point of the queue is to collect the codes and wordings we do not have yet.
 */
export function unmappedIn(outcome: NormaliseOutcome): IncomingEvent[] {
  return outcome.events.filter((e) => needsReview(e.eventCode, e.eventDesc, e.phase));
}

/* -------------------------------------------------------------------------- */

type LooseShipment = z.infer<typeof ShipmentSchema>;

function collectShipments(data: z.infer<typeof PayloadSchema>): LooseShipment[] {
  if (Array.isArray(data)) return data as LooseShipment[];
  const rec = data as Record<string, unknown>;
  if (Array.isArray(rec.envios)) return rec.envios as LooseShipment[];
  if (Array.isArray(rec.shipments)) return rec.shipments as LooseShipment[];
  return [data as LooseShipment];
}

function firstString(...xs: (string | null | undefined)[]): string | undefined {
  for (const x of xs) if (typeof x === 'string' && x.trim()) return x;
  return undefined;
}

/**
 * Which of Correos' office fields we are willing to claim we understand.
 *
 * `codired` is their office directory code and `unit` the handling unit's
 * name, so those two map. `location` and `sectionCode` do not: `location`
 * could be a town, a depot or a shelf, and a wrong guess here writes rows into
 * the offices table and puts the wrong place on a customer's screen. Both were
 * null in every sample we have, so there is nothing to check a guess against —
 * they stay on the raw payload until a real one turns up.
 */
function officeOf(e: { [k: string]: unknown }): {
  code: string | null; name: string | null; address: string | null;
} {
  const g = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined);
  return {
    code: firstString(g('codOficina'), g('codigoOficina'), g('codired')) ?? null,
    name: firstString(g('desOficina'), g('nombreOficina'), g('unit')) ?? null,
    address: firstString(g('dirOficina'), g('direccionOficina')) ?? null,
  };
}

/** The shipment-level fields worth keeping, for later. Nothing reads these. */
function contextOf(s: LooseShipment): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'reference1', 'reference3', 'expeditionCode',
    'deliveryDate', 'dateExpiration', 'dateCalculated', 'weight',
  ] as const) {
    const value = (s as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/**
 * A per-shipment error worth reporting, or null.
 *
 * `codError: 0` with an empty `desError` is what a healthy lookup carries, so
 * zero is success and the block's presence means nothing on its own. The code
 * arrives as a number in the samples we have and as a string in some of
 * Correos' other feeds, so both are accepted.
 */
function errorOf(block: unknown): { codError: number; desError: string } | null {
  if (!block || typeof block !== 'object') return null;

  const raw = (block as { codError?: unknown }).codError;
  const codError = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof codError !== 'number' || !Number.isFinite(codError) || codError === 0) return null;

  const desRaw = (block as { desError?: unknown }).desError;
  return { codError, desError: typeof desRaw === 'string' ? desRaw.trim() : '' };
}

/**
 * Correos sends dates as "dd/mm/yyyy" with the time in a separate field, and
 * sometimes as a full ISO timestamp. Their local time is Madrid's, and a naive
 * `new Date("14/09/2026")` is either invalid or, worse, September the 14th
 * read as the 9th of the 14th month.
 */
export function parseCorreosMoment(date?: string, time?: string): Date | null {
  if (!date) return null;
  const d = date.trim();

  // Full ISO — already unambiguous, and already carries its own zone.
  if (/^\d{4}-\d{2}-\d{2}T/.test(d)) {
    const parsed = new Date(d);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(d);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);

  let y: number; let mo: number; let da: number;
  if (dmy) { da = +dmy[1]; mo = +dmy[2]; y = +dmy[3]; }
  else if (ymd) { y = +ymd[1]; mo = +ymd[2]; da = +ymd[3]; }
  else return null;

  const t = (time ?? '00:00').trim();
  const hm = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(t);
  const hh = hm ? +hm[1] : 0;
  const mi = hm ? +hm[2] : 0;
  const ss = hm && hm[3] ? +hm[3] : 0;

  return madridWallClockToUtc(y, mo, da, hh, mi, ss);
}

/**
 * A wall-clock reading in Madrid, turned into the instant it happened.
 *
 * Correos gives local time with no offset. Assuming UTC would shift every
 * event by an hour or two — enough to move a deadline across midnight and put
 * a parcel in the wrong bucket on the day it matters most.
 */
export function madridWallClockToUtc(
  year: number, month: number, day: number, hour: number, minute: number, second = 0,
): Date {
  for (const offsetHours of [2, 1]) {
    const guess = new Date(Date.UTC(year, month - 1, day, hour - offsetHours, minute, second));
    const back = readMadrid(guess);
    if (back.year === year && back.month === month && back.day === day
      && back.hour === hour && back.minute === minute) {
      return guess;
    }
  }
  // The hour that does not exist on the spring-forward night. Take the later
  // reading rather than refusing an event we can otherwise use.
  return new Date(Date.UTC(year, month - 1, day, hour - 2, minute, second));
}

const madridFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function readMadrid(at: Date) {
  const p = Object.fromEntries(
    madridFmt.formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute };
}
