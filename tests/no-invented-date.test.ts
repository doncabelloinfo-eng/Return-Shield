import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildMessage, officeDetails } from '@/lib/messaging/build-message';
import type { MessageContext, MessageTemplate } from '@/lib/messaging/types';
import {
  pendingRungs, officeRungDueAt, RUNG_TEXT, FINAL_RUNGS, type LadderInput,
} from '@/lib/escalation/ladder';
import { madridDateKey } from '@/lib/time';

/**
 * No customer, and no screen, is told a date Correos did not give us.
 *
 * The system used to work out a last day — arrival plus a per-service deposit
 * window an operator typed into Settings, starting at 15 and flagged "still a
 * guess". Correos does not publish that number, does not send it, and
 * announces the return themselves when it happens. Four customer messages
 * named the guessed date outright: "Último día para recogerlo: 16 sep", "el 16
 * sep tu pedido se devuelve automáticamente", and so on.
 *
 * This file pins the replacements to the character, and pins the office ladder
 * to the days after arrival it now counts.
 */

const ctx: MessageContext = {
  firstName: 'Lucía',
  storeName: 'Don Cabello',
  orderNumber: 'DC-1001',
  shippingCode: 'PQ123456789ES',
  officeName: 'Oficina Madrid Sucursal 12',
  officeAddress: 'C/ Mejía Lequerica 8',
  officeHours: 'L–V 08:30–20:30 · S 09:30–13:00',
  officeArrivedAt: new Date('2026-10-05T11:00:00+02:00'),
  daysAtOffice: 11,
  actionUrl: null,
};

/** Every template, and the one customer text built outside `buildMessage`. */
const TEMPLATES: MessageTemplate[] = [
  'failed_first', 'failed_reminder', 'office_details', 'office_reminder',
  'office_elsewhere', 'office_four_days', 'office_last_call',
];

describe('the four new Spanish texts, exactly', () => {
  it('officeDetails ends with "Recógelo cuanto antes…"', () => {
    const text = officeDetails(ctx);
    expect(text).toContain(
      'Recógelo cuanto antes: si no se recoge a tiempo, Correos lo devuelve.',
    );
    expect(text).not.toContain('Último día para recogerlo');
  });

  it('office_reminder says Correos will return it, with no date', () => {
    expect(buildMessage('office_reminder', ctx).body).toBe(
      'Recuerda: tu pedido sigue esperándote en Oficina Madrid Sucursal 12. '
      + 'Si no se recoge a tiempo, Correos lo devuelve.',
    );
  });

  it('office_four_days counts the days it has been there', () => {
    expect(buildMessage('office_four_days', ctx).body).toBe(
      'Tu pedido DC-1001 lleva 11 días en Oficina Madrid Sucursal 12. '
      + 'Recógelo pronto para que no vuelva a origen.',
    );
  });

  it('office_last_call does the same, louder', () => {
    expect(buildMessage('office_last_call', { ...ctx, daysAtOffice: 13 }).body).toBe(
      'ÚLTIMO AVISO: tu pedido DC-1001 lleva 13 días en Oficina Madrid Sucursal 12. '
      + 'Si no se recoge, Correos lo devolverá y el pedido se cancelará.',
    );
  });

  it('keeps "tu oficina de Correos" when Correos named no office', () => {
    const nameless = { ...ctx, officeName: null };
    expect(buildMessage('office_reminder', nameless).body)
      .toContain('esperándote en tu oficina de Correos');
    expect(buildMessage('office_four_days', nameless).body)
      .toContain('días en tu oficina de Correos');
    expect(buildMessage('office_last_call', nameless).body)
      .toContain('días en tu oficina de Correos');
  });
});

describe('no customer text names a date', () => {
  it.each(TEMPLATES)('%s has no date in it', (template) => {
    const body = buildMessage(template, ctx).body;
    // A Spanish short date would read "16 sep" / "5 oct". Nothing produces one.
    expect(body).not.toMatch(/\b\d{1,2}\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\b/i);
    expect(body).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
    for (const phrase of ['Último día', 'antes del', 'se devuelve automáticamente', 'Quedan 4 días', 'quedan 2 días']) {
      expect(body, phrase).not.toContain(phrase);
    }
  });

  it('is enforced in the file itself, not only in its output', () => {
    // `shortDateEs` was the only way a date reached a customer message, and it
    // is no longer imported. A future edit that brings it back has to delete
    // this line, which is the point.
    const src = codeOf('lib/messaging/build-message.ts');
    expect(src).not.toContain('shortDateEs');
  });

  it('leaves the "Horario" sentence out when Correos gave no hours', () => {
    // Today's events carry no office details at all, so this is every parcel.
    // It used to fall back to a hard-coded line, which told customers opening
    // times nobody had checked.
    const text = officeDetails({ ...ctx, officeHours: null });
    expect(text).not.toContain('Horario');
    expect(text).toContain('te espera en Oficina Madrid Sucursal 12');

    // And still prints them when they are real.
    expect(officeDetails(ctx)).toContain('Horario: L–V 08:30–20:30 · S 09:30–13:00.');
    // Whitespace alone is not hours either.
    expect(officeDetails({ ...ctx, officeHours: '   ' })).not.toContain('Horario');
  });
});

/* -------------------------------------------------------------------------- */

const ARRIVED = new Date('2026-10-05T16:40:00+02:00');

function atOffice(fired: string[] = []): LadderInput {
  return {
    state: 'at_office',
    failedAt: null,
    officeArrivedAt: ARRIVED,
    lastEventAt: ARRIVED,
    fired: new Set(fired),
    extras: [],
    dropped: false,
    mutedUntil: null,
    reacted: false,
    staleAfterHours: 72,
  };
}

describe('the office ladder counts forward from arrival', () => {
  it('fires at +0, +3, +7, +11 and +13 Madrid days', () => {
    const due = pendingRungs(atOffice());

    expect(due.map((r) => r.id)).toEqual(['o15', 'o12', 'o8', 'o4', 'o2']);
    expect(due.map((r) => madridDateKey(r.dueAt))).toEqual([
      '2026-10-05', // the day it arrived
      '2026-10-08',
      '2026-10-12',
      '2026-10-16',
      '2026-10-18',
    ]);
  });

  it('sends the office details the moment it lands, not at a midnight gone by', () => {
    // The van reached the counter at 16:40. That day's Madrid midnight is
    // behind us, and a customer who is never told where their parcel is cannot
    // collect it — so this one rung is due at the arrival itself.
    const [details] = pendingRungs(atOffice());
    expect(details.id).toBe('o15');
    expect(details.dueAt.toISOString()).toBe(ARRIVED.toISOString());
  });

  it('never fires o0, because Correos says when a parcel goes back', () => {
    expect(pendingRungs(atOffice()).map((r) => r.id)).not.toContain('o0');
    expect(Object.keys(RUNG_TEXT)).not.toContain('o0');
    expect(FINAL_RUNGS).toEqual(['o2']);
  });

  it('does not re-fire the rungs a parcel has already had', () => {
    const left = pendingRungs(atOffice(['o15', 'o12', 'o8']));
    expect(left.map((r) => r.id)).toEqual(['o4', 'o2']);
  });

  it('keeps the rung ids, so nothing a parcel already had comes round again', () => {
    // The ids used to mean days LEFT against a fifteen-day guess, and they now
    // mean days AFTER arrival — 15 − 12 = 3, 15 − 8 = 7. Same days, same ids,
    // so a parcel part way up the ladder when this changed does not get a
    // reminder twice.
    for (const [id, daysAfter] of [['o15', 0], ['o12', 3], ['o8', 7], ['o4', 11], ['o2', 13]] as const) {
      const rung = pendingRungs(atOffice()).find((r) => r.id === id)!;
      expect(madridDateKey(rung.dueAt), id)
        .toBe(madridDateKey(officeRungDueAt(ARRIVED, daysAfter)));
    }
  });

  it('counts calendar days across a clock change, not blocks of 24 hours', () => {
    // 25 October 2026 is 25 hours long in Madrid. Adding 13 × 86,400,000 ms to
    // an arrival on the 20th lands an hour short and reads as the day before.
    const arrived = new Date('2026-10-20T16:00:00+02:00');
    expect(madridDateKey(officeRungDueAt(arrived, 13))).toBe('2026-11-02');
  });

  it('says what each rung does, without mentioning days left', () => {
    expect(RUNG_TEXT.o4).toBe('Reminder that it has been there a while');
    expect(RUNG_TEXT.o2).toBe('Last reminder plus a call you cannot skip');
    for (const text of Object.values(RUNG_TEXT)) {
      expect(text.toLowerCase(), text).not.toContain('days left');
    }
  });

  it('has no rungs at all for a parcel Correos never put at a counter', () => {
    expect(pendingRungs({ ...atOffice(), officeArrivedAt: null })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A file with its comments taken out.
 *
 * These greps are about what the code does, and the comments in these same
 * files explain at length what was removed and why — "how long the post office
 * waits", "Goes back", "not said yet". Grepping the raw text would therefore
 * fail on the explanation of the very thing it is checking is gone, and the
 * obvious fix — deleting the explanation — is the wrong one: the note is why
 * nobody puts the guess back.
 */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, JSX ones included
    .replace(/^\s*\/\/.*$/gm, '')        // whole-line // comments
    .replace(/\s\/\/.*$/gm, '');          // trailing // comments
}

describe('the deposit window is gone from the code, not just from the screen', () => {
  it('has no Settings section and no action to edit it', () => {
    const actions = codeOf('app/actions/settings.ts');
    expect(actions).not.toContain('export async function setDepositDays');
    expect(actions).not.toContain('export async function markDepositConfirmed');

    const page = codeOf('app/(panel)/settings/page.tsx');
    expect(page).not.toContain('DepositRow');
    expect(page).not.toContain('depositDays');
    expect(page).not.toContain('how long the post office waits');
    expect(page).not.toContain('Still a guess');
  });

  it('computes no deadline in the projection', () => {
    const src = codeOf('lib/state-machine/project.ts');
    expect(src).not.toContain('deadlineFrom');
    // The column is still written, as an explicit null — see repo.ts.
    const repo = codeOf('lib/shipments/repo.ts');
    expect(repo).toContain('officeDeadline: null');
    expect(repo).not.toContain('depositDaysFor');
  });

  it('shows no Goes back column on Parcels', () => {
    const table = codeOf('components/ParcelsTable.tsx');
    expect(table).not.toContain('Goes back');
  });

  it('shows no "not said yet" office, on any screen', () => {
    // Correos' events carry no office, so that placeholder was on every row of
    // the contact worklist, next to a maps link that searched for nothing.
    for (const file of [
      'components/ContactTable.tsx',
      'components/ParcelTable.tsx',
      'components/FocusCard.tsx',
    ]) {
      expect(codeOf(file), file).not.toContain('not said yet');
    }
  });
});
