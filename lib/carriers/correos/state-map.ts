import type { ShipmentState } from '@/lib/state-machine/states';

/**
 * The one place Spanish becomes a state. Nothing else in the codebase is
 * allowed to look at a Correos description — if you find yourself comparing
 * strings somewhere else, the mapping belongs here instead.
 *
 * Correos identifies events by a numeric code and sends a Spanish description
 * alongside. We match on either: the code when we recognise it, the wording
 * when we do not. Codes are the stable key, but we have only seen the wording
 * so far, so the wording is what the table is built from and codes are added
 * as they are confirmed against real traffic.
 *
 * Anything that matches neither is NOT an error. It is kept on the event, shown
 * in the timeline in Correos' own words, queued for a human to look at, and
 * changes no state. Correos will send codes nobody here has seen before, and
 * that must never take the system down.
 */

export interface CorreosMapping {
  state: ShipmentState;
  /** What we show under their Spanish, in plain English. */
  label: string;
}

/** Descriptions, normalised (see `normaliseDesc`) → state. */
const BY_DESCRIPTION: Record<string, ShipmentState> = {
  'admitido': 'accepted',
  'en transito': 'in_transit',
  'en reparto': 'out_for_delivery',
  'intento de entrega fallido - ausente': 'failed',
  'disponible en oficina para recoger': 'at_office',
  'entregado en oficina': 'collected',
  'entregado': 'delivered',
  'direccion incorrecta': 'bad_address',
  'envio rehusado por el destinatario': 'refused',
  'devolucion a origen iniciada': 'returning',
};

/**
 * Extra wordings seen in the wild for the same events. Kept separate from the
 * table above so the canonical list stays exactly the one that was agreed.
 */
const DESCRIPTION_ALIASES: Record<string, string> = {
  'admitido en oficina': 'admitido',
  'admision': 'admitido',
  'en transito hacia destino': 'en transito',
  'llegada a oficina de reparto': 'en transito',
  'salida a reparto': 'en reparto',
  'intento de entrega fallido': 'intento de entrega fallido - ausente',
  'intento de entrega fallido ausente': 'intento de entrega fallido - ausente',
  'destinatario ausente': 'intento de entrega fallido - ausente',
  'disponible en oficina': 'disponible en oficina para recoger',
  'a disposicion en oficina': 'disponible en oficina para recoger',
  'entregado al destinatario': 'entregado',
  'entrega realizada': 'entregado',
  'recogido en oficina': 'entregado en oficina',
  'direccion erronea': 'direccion incorrecta',
  'direccion insuficiente': 'direccion incorrecta',
  'rehusado': 'envio rehusado por el destinatario',
  'rehusado por el destinatario': 'envio rehusado por el destinatario',
  'devolucion a origen': 'devolucion a origen iniciada',
  'inicio de devolucion': 'devolucion a origen iniciada',
};

/**
 * Event codes confirmed against Correos' own documentation or real traffic.
 * Empty until confirmed: guessing a code is worse than falling back to the
 * wording, because a wrong code maps silently and a missing one asks a human.
 */
const BY_CODE: Record<string, ShipmentState> = {};

/** What each state means, in the words the screens use. */
export const STATE_LABEL: Record<string, string> = {
  created: 'Just created',
  accepted: 'Correos took it',
  in_transit: 'On the way',
  out_for_delivery: 'Out with the postman',
  failed: 'Nobody home',
  at_office: 'At post office',
  collected: 'Picked up at the post office',
  delivered: 'Delivered',
  bad_address: 'Wrong address',
  refused: "Doesn't want it",
  returning: 'Coming back to us',
  returned: 'Back with us',
  stale: 'No news',
};

/**
 * Lowercase, strip accents, flatten every kind of dash and collapse spaces.
 * Correos' own feed is inconsistent about "—", "-" and "–" in the same event.
 */
export function normaliseDesc(desc: string): string {
  return desc
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/[.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map one Correos event to a state, or null when we have never seen it.
 * Null is a normal outcome, not a failure.
 */
export function mapCorreosEvent(code: string | null | undefined, desc: string): ShipmentState | null {
  if (code && BY_CODE[code]) return BY_CODE[code];

  const key = normaliseDesc(desc);
  if (BY_DESCRIPTION[key]) return BY_DESCRIPTION[key];

  const alias = DESCRIPTION_ALIASES[key];
  if (alias && BY_DESCRIPTION[alias]) return BY_DESCRIPTION[alias];

  return null;
}

/** Every wording we claim to understand. Used by the tests and the docs. */
export function knownDescriptions(): string[] {
  return [...Object.keys(BY_DESCRIPTION), ...Object.keys(DESCRIPTION_ALIASES)];
}
