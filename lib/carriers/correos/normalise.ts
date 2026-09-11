import { z } from 'zod';
import { mapCorreosEvent } from './state-map';
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
 */

const loose = z.object({}).passthrough();

/** One event as Correos describes it, in either feed. */
const EventSchema = loose.extend({
  codEvento: z.string().optional(),
  codigoEvento: z.string().optional(),
  eventCode: z.string().optional(),
  desEvento: z.string().optional(),
  descripcionEvento: z.string().optional(),
  eventDescription: z.string().optional(),
  fecEvento: z.string().optional(),
  fechaEvento: z.string().optional(),
  eventDate: z.string().optional(),
  horEvento: z.string().optional(),
  horaEvento: z.string().optional(),
  eventTime: z.string().optional(),
  codOficina: z.string().optional(),
  codigoOficina: z.string().optional(),
  desOficina: z.string().optional(),
  nombreOficina: z.string().optional(),
  dirOficina: z.string().optional(),
  direccionOficina: z.string().optional(),
});

const ShipmentSchema = loose.extend({
  codEnvio: z.string().optional(),
  codigoEnvio: z.string().optional(),
  shippingCode: z.string().optional(),
  eventos: z.array(EventSchema).optional(),
  events: z.array(EventSchema).optional(),
});

const PayloadSchema = z.union([
  ShipmentSchema,
  z.array(ShipmentSchema),
  loose.extend({ envios: z.array(ShipmentSchema) }),
  loose.extend({ shipments: z.array(ShipmentSchema) }),
]);

export interface NormaliseOutcome {
  events: IncomingEvent[];
  /** Things we could not read. Kept so a human can look at them. */
  problems: string[];
}

export function normalisePayload(
  payload: unknown,
  source: 'push' | 'poll',
): NormaliseOutcome {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { events: [], problems: ['payload did not look like a Correos tracking body'] };
  }

  const shipments = collectShipments(parsed.data);
  const events: IncomingEvent[] = [];
  const problems: string[] = [];

  for (const s of shipments) {
    const shippingCode = firstString(s.codEnvio, s.codigoEnvio, s.shippingCode)?.trim().toUpperCase();
    if (!shippingCode) { problems.push('a shipment with no tracking code'); continue; }

    const list = s.eventos ?? s.events ?? [];
    if (!list.length) problems.push(`${shippingCode}: no events in the payload`);

    for (const e of list) {
      const desc = firstString(e.desEvento, e.descripcionEvento, e.eventDescription)?.trim();
      if (!desc) { problems.push(`${shippingCode}: an event with no description`); continue; }

      const occurredAt = parseCorreosMoment(
        firstString(e.fecEvento, e.fechaEvento, e.eventDate),
        firstString(e.horEvento, e.horaEvento, e.eventTime),
      );
      if (!occurredAt) { problems.push(`${shippingCode}: could not read the date on "${desc}"`); continue; }

      // The code is the dedupe key. When Correos does not send one, the
      // description stands in — two different events at the same instant with
      // the same wording are the same event whatever it is called.
      const eventCode = firstString(e.codEvento, e.codigoEvento, e.eventCode)?.trim()
        ?? `desc:${desc.slice(0, 60)}`;

      events.push({
        shippingCode,
        eventCode,
        eventDesc: desc,
        occurredAt,
        source,
        officeCode: firstString(e.codOficina, e.codigoOficina) ?? null,
        officeName: firstString(e.desOficina, e.nombreOficina) ?? null,
        officeAddress: firstString(e.dirOficina, e.direccionOficina) ?? null,
        rawPayload: e,
      });
    }
  }

  return { events, problems };
}

/** Does this payload contain anything we have never seen a mapping for? */
export function unmappedIn(outcome: NormaliseOutcome): IncomingEvent[] {
  return outcome.events.filter((e) => mapCorreosEvent(e.eventCode, e.eventDesc) === null);
}

/* -------------------------------------------------------------------------- */

type LooseShipment = z.infer<typeof ShipmentSchema>;

function collectShipments(data: z.infer<typeof PayloadSchema>): LooseShipment[] {
  if (Array.isArray(data)) return data;
  const rec = data as Record<string, unknown>;
  if (Array.isArray(rec.envios)) return rec.envios as LooseShipment[];
  if (Array.isArray(rec.shipments)) return rec.shipments as LooseShipment[];
  return [data as LooseShipment];
}

function firstString(...xs: (string | undefined)[]): string | undefined {
  for (const x of xs) if (typeof x === 'string' && x.trim()) return x;
  return undefined;
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
