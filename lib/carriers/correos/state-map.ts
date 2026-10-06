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
  // The label exists in Correos' systems and the parcel is still with us.
  'prerregistrado': 'created',
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

  /*
   * Wordings taken from Correos' own public tracker, 7 October.
   *
   * Each one is here because its meaning is unambiguous on its own. The ones
   * NOT here are the point of the list:
   *
   *   "Llegada a la oficina de destino" is not `at_office`. It says the parcel
   *   reached the office, not that it is waiting there for the customer —
   *   "A disposición del destinatario" is what says that, and it is the event
   *   the deposit countdown starts from. Mapping the arrival would start the
   *   countdown early and send a customer to collect a parcel that is not yet
   *   collectable.
   *
   *   "Alta en unidad de reparto" is the delivery unit booking it in, which is
   *   still in transit rather than out with the postman. "En reparto" is the
   *   one that means a van.
   *
   * Both of those are left to the review queue, where a human can look at
   * real traffic and decide. Guessing either costs a wrong countdown.
   */
  'envio prerregistrado': 'prerregistrado',
  'envio prerregistrado en los sistemas de correos pendiente de deposito': 'prerregistrado',
  'el envio ha tenido admision en origen': 'admitido',
  'envio clasificado en centro logistico': 'en transito',
  'envio clasificado': 'en transito',
  'clasificado': 'en transito',
  'llegada a la oficina de destino': 'en transito',
  'alta en unidad de reparto': 'en transito',
  'a disposicion del destinatario': 'disponible en oficina para recoger',
  'envio entregado en buzon domiciliario': 'entregado',
  'retorno a remitente': 'devolucion a origen iniciada',
};

/**
 * Event codes confirmed against real traffic from the trackpub v2 `/search`
 * response. A code is only added here once it has been seen with its wording,
 * because a guessed code maps silently and wrongly, while a missing one asks a
 * human. Everything still unconfirmed falls through to the wording below.
 */
const BY_CODE: Record<string, ShipmentState> = {
  // Captured 6 October from a real parcel: PRE-ADMISIÓN → EN CAMINO.
  A090000V: 'created',          // "Prerregistrado"
  A010000V: 'accepted',         // "Admitido."
  P040000V: 'in_transit',       // "Clasificado"
};

/**
 * Correos' coarse delivery phase (`phaseDes`), as a last resort.
 *
 * This is the list Mi Oficina offers as a filter, so it is the full set. It is
 * deliberately the weakest signal available: a phase covers dozens of distinct
 * events, so `EN CAMINO` is true of a parcel that was just classified and of
 * one sitting in a depot three days later. It can keep a parcel moving through
 * the state machine when we have never seen the event before, and it must
 * never be allowed to overrule a code or a wording that we do know.
 *
 * `SIN FASE` is absent on purpose rather than mapped to anything — it is
 * Correos saying they have no phase for this event, which is not information.
 *
 * Keyed by `normalisePhase`, which is `normaliseDesc` without the dash
 * flattening — that step would turn `PRE-ADMISIÓN` into `pre - admision`.
 */
const BY_PHASE: Record<string, ShipmentState> = {
  'pre-admision': 'created',
  'en camino': 'in_transit',
  'en entrega': 'out_for_delivery',
  entregado: 'delivered',
};

/**
 * What each state means, in the words the screens use.
 *
 * ENGLISH LEADS, EVERYWHERE THE OPERATOR LOOKS. The operator does not read
 * Spanish, so a screen that shows only "Clasificado" is a screen they cannot
 * use. Correos' own words still appear, in `STATE_ES` below, as a smaller
 * second line — because when somebody rings Correos or opens the public
 * tracker, that is the phrase they need to match.
 *
 * Customer-facing text is the other way round and stays Spanish: the WhatsApp
 * and email templates, and the public /e/{token} pages. Those are read by
 * Spanish customers, and nothing here touches them.
 */
export const STATE_LABEL: Record<string, string> = {
  created: 'Pre-admission (label made, not handed to Correos)',
  accepted: 'Accepted by Correos',
  in_transit: 'On the way',
  out_for_delivery: 'Out for delivery',
  failed: 'Failed delivery (nobody home)',
  at_office: 'Waiting at the post office',
  collected: 'Picked up at the post office',
  delivered: 'Delivered',
  bad_address: 'Wrong address',
  refused: 'Refused by customer',
  returning: 'Coming back',
  returned: 'Returned',
  stale: 'No news from Correos',
};

/**
 * A short English label, for places too narrow for the full one — a chip on a
 * row, the heading on a parcel. Same meaning, fewer words.
 */
export const STATE_LABEL_SHORT: Record<string, string> = {
  created: 'Pre-admission',
  accepted: 'Accepted',
  in_transit: 'On the way',
  out_for_delivery: 'Out for delivery',
  failed: 'Nobody home',
  at_office: 'At post office',
  collected: 'Picked up',
  delivered: 'Delivered',
  bad_address: 'Wrong address',
  refused: 'Refused',
  returning: 'Coming back',
  returned: 'Returned',
  stale: 'No news',
};

/**
 * Correos' own word for each state, for the muted second line.
 *
 * Not a translation of the English: it is the phrase Correos themselves use,
 * so it matches what the public tracker and their phone agents say. `stale` is
 * empty because it is not a Correos state at all — it is our own word for
 * silence, and inventing Spanish for it would be putting words in their mouth.
 */
export const STATE_ES: Record<string, string> = {
  created: 'Pre-admisión / Prerregistrado',
  accepted: 'Admitido',
  in_transit: 'Clasificado / En tránsito',
  out_for_delivery: 'En reparto',
  failed: 'Ausente / Intento de entrega fallido',
  at_office: 'Disponible en oficina',
  collected: 'Entregado en oficina',
  delivered: 'Entregado',
  bad_address: 'Dirección incorrecta',
  refused: 'Rehusado',
  returning: 'En devolución',
  returned: 'Devuelto',
  stale: '',
};

/** The pair a screen renders: English first, Correos' words beneath. */
export interface Bilingual {
  en: string;
  /** Empty when Correos has no word of their own for it. */
  es: string;
}

export function stateLabels(state: string | null | undefined, short = false): Bilingual {
  if (!state) return { en: 'Not recognised yet', es: '' };
  const table = short ? STATE_LABEL_SHORT : STATE_LABEL;
  return { en: table[state] ?? state, es: STATE_ES[state] ?? '' };
}

/**
 * What one Correos event means, for a timeline row: our English on top, their
 * exact sentence underneath.
 *
 * `desc` is passed through untouched. It is evidence — the sentence to read
 * out on the phone — so it is never rewritten, only labelled.
 */
export function eventLabels(mappedState: string | null | undefined, desc: string): Bilingual {
  return { en: mappedState ? (STATE_LABEL[mappedState] ?? mappedState) : 'Not recognised yet', es: desc };
}

/**
 * Lowercase, strip accents, flatten every kind of dash and collapse spaces.
 * Correos' own feed is inconsistent about "—", "-" and "–" in the same event.
 *
 * The order of the last three steps is load-bearing, and used to be wrong.
 * Whitespace is collapsed and trimmed BEFORE the trailing punctuation is
 * stripped, because `/[.,;:]+$/` is anchored at the end of the string: with
 * `"Admitido. "` the `$` sat after the space, the period survived, and the
 * event did not match `admitido`. Correos does send trailing punctuation —
 * `summaryText` is literally `"Admitido."` — so this is the real traffic, not
 * a hypothetical.
 */
export function normaliseDesc(desc: string): string {
  return desc
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
    // `…` as well as `.`: Correos' tracker truncates longer wordings with a
    // real ellipsis character, so "Envío prerregistrado…" and the full
    // sentence are the same event and must reach the same state.
    .replace(/[.,;:\u2026]+$/g, '')
    .trim();
}

/**
 * The same, minus the dash flattening.
 *
 * Phases are single words or short fixed strings where a hyphen is part of the
 * name: `PRE-ADMISIÓN` is one token, and `normaliseDesc` would spell it
 * `pre - admision`. Descriptions need the flattening because Correos mixes
 * "—", "-" and "–" inside one sentence; phases never do.
 */
export function normalisePhase(phase: string): string {
  return phase
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:\u2026]+$/g, '')
    .trim();
}

/** Which signal decided the state. See `matchCorreosEvent`. */
export type MappingSource = 'code' | 'description' | 'phase';

export interface CorreosMatch {
  state: ShipmentState;
  via: MappingSource;
}

/**
 * Map one Correos event to a state, saying which signal decided it.
 *
 * Strictly in order of how much the signal is worth: the code when we
 * recognise it, then the wording, then — only if neither is known — the coarse
 * phase. A match `via: 'phase'` is a guess good enough to move the state
 * machine and not good enough to stop asking a human, which is why callers
 * queue it for review all the same.
 *
 * Null is a normal outcome, not a failure.
 */
export function matchCorreosEvent(
  code: string | null | undefined,
  desc: string,
  phase?: string | null,
): CorreosMatch | null {
  const byCode = code ? BY_CODE[code.trim()] : undefined;
  if (byCode) return { state: byCode, via: 'code' };

  const key = normaliseDesc(desc);
  if (BY_DESCRIPTION[key]) return { state: BY_DESCRIPTION[key], via: 'description' };

  const alias = DESCRIPTION_ALIASES[key];
  if (alias && BY_DESCRIPTION[alias]) return { state: BY_DESCRIPTION[alias], via: 'description' };

  if (phase) {
    const byPhase = BY_PHASE[normalisePhase(phase)];
    if (byPhase) return { state: byPhase, via: 'phase' };
  }

  return null;
}

/**
 * The state alone, for callers that do not care how it was reached.
 *
 * Anything deciding whether a human should look at the event wants
 * `matchCorreosEvent` instead: this cannot tell a recognised event from one
 * rescued by its phase.
 */
export function mapCorreosEvent(
  code: string | null | undefined,
  desc: string,
  phase?: string | null,
): ShipmentState | null {
  return matchCorreosEvent(code, desc, phase)?.state ?? null;
}

/**
 * Is this event one a human should still look at?
 *
 * True when nothing matched, and also when only the phase did: the phase keeps
 * the parcel moving, but the code and the wording are still unknown to us and
 * that is exactly what the review queue is for.
 */
export function needsReview(
  code: string | null | undefined,
  desc: string,
  phase?: string | null,
): boolean {
  const match = matchCorreosEvent(code, desc, phase);
  return match === null || match.via === 'phase';
}

/** Every wording we claim to understand. Used by the tests and the docs. */
export function knownDescriptions(): string[] {
  return [...Object.keys(BY_DESCRIPTION), ...Object.keys(DESCRIPTION_ALIASES)];
}

/** Every event code confirmed against real traffic. For the tests and docs. */
export function knownCodes(): string[] {
  return Object.keys(BY_CODE);
}
