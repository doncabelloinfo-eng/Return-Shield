/**
 * A real trackpub v2 `/search` response.
 *
 * Captured from production on 6 October 2026. Every personal field was blank
 * or null in the capture and is kept that way here — this file is committed to
 * a public repository, and a fixture is not a place for a customer's name or
 * address.
 *
 * It is reproduced field for field, nulls included, because the nulls are the
 * interesting part: `z.string().optional()` rejects null, so a schema written
 * against a tidied-up sample parses the tidied-up sample and fails on the real
 * one. `phase`, `unit`, `location`, `codired` and `sectionCode` all arrive as
 * explicit nulls.
 */

/** The third event's wording is in `summaryText`; `expandedText` is longer. */
export const REAL_SEARCH_RESPONSE: unknown = [
  {
    code: 'PKA6TP9800095100123700D',
    reference1: '#22430',
    reference3: 'MODULO_Shopify/v1.2.99',
    expeditionCode: 'PKA6TP980009510M',
    weight: 2900,
    totalPackage: 1,
    numberPackage: 1,
    deliveryDate: null,
    dateExpiration: null,
    dateCalculated: null,
    remitName: null,
    destiName: null,
    receiverName: null,
    events: [
      {
        eventDate: '06/10/2026',
        eventHours: '16:17:03',
        eventCode: 'A090000V',
        phase: null,
        phaseDes: 'PRE-ADMISIÓN',
        summaryText: 'Prerregistrado',
        expandedText: 'Envío prerregistrado en los sistemas de Correos pendiente de depósito',
        unit: null,
        location: null,
        codired: null,
        sectionCode: null,
        desNipAgent: null,
        turn: null,
        color: null,
        webaction: null,
        paramWebAction: null,
        coordinateX: null,
        coordinateY: null,
      },
      {
        eventDate: '06/10/2026',
        eventHours: '20:13:23',
        eventCode: 'A010000V',
        phaseDes: 'EN CAMINO',
        summaryText: 'Admitido.',
        expandedText: 'El envío ha tenido admisión en origen.',
      },
      {
        eventDate: '06/10/2026',
        eventHours: '20:13:43',
        eventCode: 'P040000V',
        phaseDes: 'EN CAMINO',
        summaryText: 'Clasificado',
        expandedText: 'Envío clasificado en Centro Logístico',
      },
    ],
    error: { codError: 0, desError: '' },
    associatedShipments: [],
  },
];

export const REAL_CODE = 'PKA6TP9800095100123700D';

/** One shipment in the v2 shape, for building batches. */
export function v2Shipment(
  code: string,
  events: Array<Record<string, unknown>> = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    reference1: null,
    expeditionCode: null,
    events,
    error: { codError: 0, desError: '' },
    associatedShipments: [],
    ...extra,
  };
}

/** One event in the v2 shape. */
export function v2Event(
  eventCode: string,
  summaryText: string,
  phaseDes: string | null = null,
  at: { date?: string; hours?: string } = {},
): Record<string, unknown> {
  return {
    eventDate: at.date ?? '06/10/2026',
    eventHours: at.hours ?? '16:17:03',
    eventCode,
    phase: null,
    phaseDes,
    summaryText,
    expandedText: `${summaryText} (long form)`,
    unit: null,
    location: null,
    codired: null,
    sectionCode: null,
  };
}
