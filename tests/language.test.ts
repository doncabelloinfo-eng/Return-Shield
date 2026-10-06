import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDb } from '@/db';
import { shipmentEvents } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import {
  STATE_LABEL, STATE_ES, STATE_LABEL_SHORT, stateLabels, eventLabels, mapCorreosEvent,
} from '@/lib/carriers/correos/state-map';
import { SHIPMENT_STATES } from '@/lib/state-machine/states';
import { PARCEL_TABS } from '@/lib/views/parcels';
import { parcelsView } from '@/lib/views/parcels';
import { CLOSE_REASONS, CLOSE_REASON_KEYS } from '@/lib/escalation/close-reasons';
import { officeDetails, DEFAULT_OFFICE_HOURS } from '@/lib/messaging/build-message';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * English for the operator, Spanish for the customer.
 *
 * The operator reads English only. A screen that leads with "Clasificado" is a
 * screen they have to decode before they can act, and the parcel timeline was
 * exactly that: a column of Spanish sentences in italics with our English in a
 * small chip underneath.
 *
 * The other half of the rule matters just as much and is easier to break by
 * accident: the customer-facing text is Spanish and must stay Spanish. The
 * WhatsApp templates and the public /e/{token} pages are read by Spanish
 * customers, and "translating everything to English" would send them a message
 * they cannot read.
 */

const SPANISH_WORDS = [
  'Clasificado', 'Admitido', 'Prerregistrado', 'Entregado', 'Rehusado',
  'Devuelto', 'oficina', 'reparto', 'tránsito', 'Dirección',
];

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T10:00:00+02:00');
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

/* ========================================================================== */

describe('status labels', () => {
  it('has an English label for every state', () => {
    for (const state of SHIPMENT_STATES) {
      expect(STATE_LABEL[state], state).toBeTruthy();
      expect(STATE_LABEL_SHORT[state], state).toBeTruthy();
    }
  });

  it('has no Spanish in any English label', () => {
    for (const state of SHIPMENT_STATES) {
      for (const word of SPANISH_WORDS) {
        expect(STATE_LABEL[state].toLowerCase(), state).not.toContain(word.toLowerCase());
        expect(STATE_LABEL_SHORT[state].toLowerCase(), state).not.toContain(word.toLowerCase());
      }
    }
  });

  it('carries Correos\' own word for every state they have one for', () => {
    for (const state of SHIPMENT_STATES) {
      // `stale` is ours, not theirs: it is our word for silence, and inventing
      // Spanish for it would put words in Correos' mouth.
      if (state === 'stale') {
        expect(STATE_ES[state]).toBe('');
        continue;
      }
      expect(STATE_ES[state], state).toBeTruthy();
    }
  });

  it('puts the English first and the Spanish second', () => {
    const pair = stateLabels('in_transit');
    expect(pair.en).toBe('On the way');
    expect(pair.es).toBe('Clasificado / En tránsito');
  });

  it('says so in English when nothing is recognised', () => {
    expect(stateLabels(null).en).toBe('Not recognised yet');
    expect(eventLabels(null, 'Una cosa nueva')).toEqual({
      en: 'Not recognised yet',
      es: 'Una cosa nueva',
    });
  });

  it('keeps Correos\' sentence untouched as the second line', () => {
    // Their wording is evidence — the sentence to read out on the phone — so
    // it is labelled, never rewritten.
    const pair = eventLabels('accepted', 'El envío ha tenido admisión en origen');
    expect(pair.en).toBe('Accepted by Correos');
    expect(pair.es).toBe('El envío ha tenido admisión en origen');
  });
});

describe('the tabs', () => {
  it('all lead in English', () => {
    for (const tab of PARCEL_TABS) {
      expect(tab.en, tab.id).toBeTruthy();
      for (const word of SPANISH_WORDS) {
        expect(tab.en.toLowerCase(), tab.id).not.toContain(word.toLowerCase());
      }
    }
  });

  it('carry Correos\' word on the status tabs', () => {
    // The ones with no Spanish are the ones Correos has no word for: our own
    // groupings, and the two stuck tabs.
    const ours = ['all_open', 'stale', 'stuck_30', 'closed'];
    for (const tab of PARCEL_TABS) {
      if (ours.includes(tab.id)) continue;
      expect(tab.es, tab.id).toBeTruthy();
    }
  });

  it('renders a row with English status and Spanish beneath', async () => {
    await makeShipment({ shippingCode: 'PL1', state: 'in_transit' });

    const v = await parcelsView({ status: 'in_transit', at: clock.now() });

    expect(v.rows[0].status.en).toBe('On the way');
    expect(v.rows[0].status.es).toBe('Clasificado / En tránsito');
  });

  it('renders an event with English first and Correos\' sentence beneath', async () => {
    const fix = await makeShipment({ shippingCode: 'PL2', state: 'accepted' });
    await getDb().insert(shipmentEvents).values({
      shipmentId: fix.shipmentId,
      rawPayload: {},
      eventCode: 'A010000V',
      eventDesc: 'Admitido.',
      occurredAt: clock.now(),
      receivedAt: clock.now(),
      source: 'poll',
      mappedState: 'accepted',
    });

    const v = await parcelsView({ status: 'accepted', at: clock.now() });

    expect(v.rows[0].event?.en).toBe('Accepted by Correos');
    expect(v.rows[0].event?.es).toBe('Admitido.');
  });
});

describe('badges and close reasons', () => {
  it('are in English', async () => {
    await makeShipment({
      shippingCode: 'PL3', state: 'in_transit',
      orderCreatedAt: new Date('2026-09-01T10:00:00+02:00'),
    });

    const v = await parcelsView({ status: 'stuck_30', at: clock.now() });

    expect(v.rows[0].badges[0]).toMatch(/^\d+ days, still not finished$/);
  });

  it('reads every close reason in English, with an English hint', () => {
    for (const key of CLOSE_REASON_KEYS) {
      const { label, hint } = CLOSE_REASONS[key];
      expect(label).toBeTruthy();
      expect(hint).toBeTruthy();
      for (const word of SPANISH_WORDS) {
        expect(label.toLowerCase(), key).not.toContain(word.toLowerCase());
      }
    }
  });
});

/* ========================================================================== */

describe('customer-facing text stays Spanish', () => {
  it('still writes the office message in Spanish', () => {
    const text = officeDetails({
      firstName: 'Lucía',
      storeName: 'Don Cabello',
      orderNumber: 'DC-1001',
      shippingCode: 'PQ123456789ES',
      officeName: 'Oficina Madrid Sucursal 12',
      officeAddress: 'C/ Mejía Lequerica 8',
      officeHours: DEFAULT_OFFICE_HOURS,
      deadline: new Date('2026-10-20T21:59:59+02:00'),
      actionUrl: null,
    });

    // The customer is Spanish. Translating this would send them a message they
    // cannot read, which is the opposite of the point.
    expect(text).toMatch(/[áéíóúñ¡¿]/);
    expect(text).toContain('Hola Lucía');
    expect(text.toLowerCase()).not.toContain('hello');
    expect(text.toLowerCase()).not.toContain('your parcel');
  });

  it('has not had its templates rewritten', () => {
    // A guard rather than a snapshot: the exact wording is the business's, and
    // nothing in an English-first change should be editing it.
    const src = readFileSync('lib/messaging/build-message.ts', 'utf8');
    for (const phrase of [
      'Hola',
      'tu oficina de Correos',
      'Confirma tu dirección o pide una nueva entrega.',
      'Elegir otra dirección',
    ]) {
      expect(src, phrase).toContain(phrase);
    }
  });

  it('keeps the customer action labels Spanish', async () => {
    const { CUSTOMER_ACTIONS } = await import('@/lib/escalation/outcomes');

    // These are the buttons on the public /e/{token} page, tapped by the
    // customer on their own phone.
    expect(CUSTOMER_ACTIONS.ok_address).toBe('Mi dirección es correcta');
    expect(CUSTOMER_ACTIONS.change_address).toBe('Quiero cambiar la dirección');
  });
});

/* ========================================================================== */

describe('the panel layout', () => {
  it('renders without the dock', () => {
    const src = readFileSync('app/(panel)/layout.tsx', 'utf8');

    // The "Customer phone / Correos updates" panel is gone and the main
    // content takes the full width, which the eight-column Parcels table
    // needs.
    expect(src).not.toMatch(/<Dock\s*\/>/);
    expect(src).not.toContain("from '@/components/Dock'");
  });

  it('keeps the component files, because WhatsApp is coming back', () => {
    // Deleting them would make Step 2 a rewrite rather than a re-import.
    expect(() => readFileSync('components/Dock.tsx', 'utf8')).not.toThrow();
    expect(() => readFileSync('components/DockTabs.tsx', 'utf8')).not.toThrow();
  });

  it('leaves the parcel page\'s own WhatsApp buttons alone', () => {
    const src = readFileSync('app/(panel)/parcel/[id]/page.tsx', 'utf8');
    expect(src).toContain('waHref');
  });

  it('has a Parcels tab after Post office', () => {
    const src = readFileSync('components/Tabs.tsx', 'utf8');
    const office = src.indexOf("'/office'");
    const parcels = src.indexOf("'/parcels'");
    const importTab = src.indexOf("'/import'");

    expect(office).toBeGreaterThan(-1);
    expect(parcels).toBeGreaterThan(office);
    expect(parcels).toBeLessThan(importTab);
  });
});

describe('the parcel timeline', () => {
  it('leads with the English meaning', () => {
    const src = readFileSync('components/EventTimeline.tsx', 'utf8');

    // `e.state` is our English and `e.desc` is Correos'. English has to come
    // first in the markup, which is what this asserts — the old version had
    // `e.desc` in italics on top and `e.state` in a chip below.
    const state = src.indexOf('{e.state}');
    const desc = src.indexOf('{e.desc}');
    expect(state).toBeGreaterThan(-1);
    expect(desc).toBeGreaterThan(state);
  });
});

describe('the new tracker wordings', () => {
  it.each([
    ['Envío prerregistrado…', 'created'],
    ['Envío prerregistrado en los sistemas de Correos pendiente de depósito', 'created'],
    ['El envío ha tenido admisión en origen', 'accepted'],
    ['Envío clasificado en centro logístico', 'in_transit'],
    ['En tránsito', 'in_transit'],
    ['Llegada a la oficina de destino', 'in_transit'],
    ['Alta en unidad de reparto', 'in_transit'],
    ['En reparto', 'out_for_delivery'],
    ['A disposición del destinatario', 'at_office'],
    ['Entregado', 'delivered'],
    ['Envío entregado en buzón domiciliario', 'delivered'],
    ['Retorno a remitente', 'returning'],
  ])('maps %j to %s', (desc, state) => {
    expect(mapCorreosEvent(null, desc)).toBe(state);
  });

  it('does not treat reaching the office as being available there', () => {
    // "Llegada a la oficina de destino" says the parcel reached the office,
    // not that the customer can collect it. Mapping it to `at_office` would
    // start the deposit countdown early and send somebody to collect a parcel
    // that is not collectable yet.
    expect(mapCorreosEvent(null, 'Llegada a la oficina de destino')).toBe('in_transit');
    expect(mapCorreosEvent(null, 'A disposición del destinatario')).toBe('at_office');
  });

  it('does not treat booking into a delivery unit as being out with the postman', () => {
    expect(mapCorreosEvent(null, 'Alta en unidad de reparto')).toBe('in_transit');
    expect(mapCorreosEvent(null, 'En reparto')).toBe('out_for_delivery');
  });

  it('still refuses to guess anything else', () => {
    expect(mapCorreosEvent(null, 'Incidencia en el proceso de entrega')).toBeNull();
    expect(mapCorreosEvent(null, 'Algo completamente nuevo')).toBeNull();
  });
});
