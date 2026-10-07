import type { ShipmentState } from '@/lib/state-machine/states';
import type { MessageTemplate } from '@/lib/messaging/types';
import { DAY, HOUR, MINUTE } from '@/lib/clock';
import { madridMidnightUtc, madridParts } from '@/lib/time';

/**
 * The ladder, as a pure function of a shipment's facts and the current time.
 *
 * It tells you which rungs are due and what each one does. It reads no clock
 * of its own, touches no database and sends nothing — which is why the whole
 * fifteen days can be driven in a test in under a second.
 */

export type RungId =
  // After a failed delivery, counted forward from the failure.
  | 'f15' | 'f4h' | 'f24' | 'f48'
  /*
   * At the office, counted forward from arrival.
   *
   * The ids are historical and deliberately kept: they used to mean "fifteen
   * days left", "twelve days left" and so on, counted back from a deadline
   * that was a guess. The days they fire on have not changed — a fifteen-day
   * window put `o12` on day 3 after arrival, and `o12` is day 3 after arrival
   * now — so keeping the ids means every rung a parcel has already fired stays
   * fired, and nobody gets a reminder twice because we renamed something.
   *
   * `o0` is gone. It existed to say "the window is up", which was our
   * arithmetic rather than Correos' — and Correos says it themselves, with an
   * event, which the normal return handling already acts on.
   */
  | 'o15' | 'o12' | 'o8' | 'o4' | 'o2'
  // Nothing from Correos for too long.
  | 'stale';

export type ExtraKind = 'recheck' | 'retry' | 'nochk';

export type RungEffect =
  /** Write a message: put in front of an operator, or sent if a provider can. */
  | { kind: 'message'; template: MessageTemplate }
  /** Put it on someone's call list. */
  | { kind: 'call_task'; reason: string; label: string }
  /** Ask Correos what happened. */
  | { kind: 'chase_carrier'; label: string }
  /** Correos normally has it at the office by now; go and look. */
  | { kind: 'expect_at_office' };

export interface DueRung {
  id: string;
  /** The base rung this came from, for anything that reasons about the rung. */
  base: RungId | ExtraKind;
  dueAt: Date;
  effect: RungEffect;
}

/** Everything the ladder needs to know about one shipment. */
export interface LadderInput {
  state: ShipmentState;
  failedAt: Date | null;
  /** Correos' "A disposición del destinatario" time. The office rungs' anchor. */
  officeArrivedAt: Date | null;
  lastEventAt: Date | null;
  /** Rungs that have already fired or been silenced. Never fire again. */
  fired: ReadonlySet<string>;
  /** Follow-ups the engine booked for itself. */
  extras: readonly { rungId: string; kind: ExtraKind; dueAt: Date }[];
  /** "Stop chasing this one". Silences everything, permanently. */
  dropped: boolean;
  /** Quiet until — a call outcome asked the system to wait. */
  mutedUntil: Date | null;
  /** Has the customer ever answered? Drives the no-reply check. */
  reacted: boolean;
  /** How long Correos may say nothing before we ask. From settings. */
  staleAfterHours: number;
}

/** Human-readable plan lines, shown on the parcel page under "what happens next". */
export const RUNG_TEXT: Record<RungId | ExtraKind, string> = {
  f15: 'First message about the missed delivery',
  f4h: 'Reminder to confirm the address',
  f24: 'Call task if nobody has replied',
  f48: 'Correos moves it to the post office',
  o15: 'Message with the office details and the code',
  o12: 'Reminder that it is still waiting',
  o8: 'Offer to send it somewhere else',
  o4: 'Reminder that it has been there a while',
  o2: 'Last reminder plus a call you cannot skip',
  stale: 'Flag it if Correos still says nothing',
  recheck: 'Check whether they actually collected it',
  retry: 'Bring them back to your call list',
  nochk: 'Call task if the message gets no reply',
};

const EFFECTS: Record<Exclude<RungId, 'stale'>, RungEffect> = {
  f15: { kind: 'message', template: 'failed_first' },
  f4h: { kind: 'message', template: 'failed_reminder' },
  f24: { kind: 'call_task', reason: 'no_reply_after_failure', label: 'A day since nobody was home' },
  f48: { kind: 'expect_at_office' },
  o15: { kind: 'message', template: 'office_details' },
  o12: { kind: 'message', template: 'office_reminder' },
  o8: { kind: 'message', template: 'office_elsewhere' },
  o4: { kind: 'message', template: 'office_four_days' },
  // o2 sends a message *and* books a call. The call is added by the runner.
  o2: { kind: 'message', template: 'office_last_call' },
};

/** Rungs a `delivered`, `collected` or customer reply silences. */
export const SILENCEABLE: readonly RungId[] = ['f15', 'f4h', 'f24', 'f48', 'o15', 'o12', 'o8', 'o4', 'stale'];
/** The one that survives a "they said they'd collect it" — it is the backstop. */
export const FINAL_RUNGS: readonly RungId[] = ['o2'];

/**
 * Days after arrival at the office that each rung fires.
 *
 * Exactly the days the fifteen-day guess produced, so nothing shifts for a
 * parcel already sitting at a counter: 15 − 12 = 3, 15 − 8 = 7, and so on.
 * The difference is where the number comes from — the day Correos said the
 * parcel got there, rather than a last day nobody confirmed.
 */
const OFFICE_OFFSETS: readonly { id: Exclude<RungId, 'stale'>; days: number }[] = [
  { id: 'o15', days: 0 },
  { id: 'o12', days: 3 },
  { id: 'o8', days: 7 },
  { id: 'o4', days: 11 },
  { id: 'o2', days: 13 },
];

/**
 * When an office rung is due: the start of the Nth Madrid day after arrival.
 *
 * Counting in calendar days rather than adding N×24h matters twice a year, and
 * it also means a reminder lands on the morning of its day rather than at
 * whatever o'clock the parcel happened to reach the counter — nobody is
 * messaged at 06:40 because that is when the van got there.
 */
export function officeRungDueAt(arrivedAt: Date, daysAfter: number): Date {
  const p = madridParts(arrivedAt);
  return madridMidnightUtc(p.year, p.month, p.day + daysAfter);
}

/**
 * Every rung not yet fired, with when it is due. Past-due rungs come back with
 * their original time so the caller can fire them in order after an outage.
 */
export function pendingRungs(s: LadderInput): DueRung[] {
  if (s.dropped) return [];

  const out: DueRung[] = [];

  if (s.state === 'failed' && s.failedAt) {
    const t = s.failedAt.getTime();
    out.push(
      { id: 'f15', base: 'f15', dueAt: new Date(t + 15 * MINUTE), effect: EFFECTS.f15 },
      { id: 'f4h', base: 'f4h', dueAt: new Date(t + 4 * HOUR), effect: EFFECTS.f4h },
      { id: 'f24', base: 'f24', dueAt: new Date(t + 24 * HOUR), effect: EFFECTS.f24 },
      { id: 'f48', base: 'f48', dueAt: new Date(t + 48 * HOUR), effect: EFFECTS.f48 },
    );
  }

  if (s.state === 'at_office' && s.officeArrivedAt) {
    const arrived = s.officeArrivedAt.getTime();
    for (const { id, days } of OFFICE_OFFSETS) {
      const natural = officeRungDueAt(s.officeArrivedAt, days);

      // `o15` is the message that says where the parcel is and what to show at
      // the counter, and it is due on the day of arrival — whose Madrid
      // midnight is behind us by the time the van gets there. A customer who
      // is never told where their parcel is cannot collect it, so this one is
      // due the moment it lands rather than at a midnight already past.
      const dueAt = natural.getTime() < arrived ? s.officeArrivedAt : natural;
      out.push({ id, base: id, dueAt, effect: EFFECTS[id] });
    }
  }

  if ((s.state === 'accepted' || s.state === 'in_transit' || s.state === 'out_for_delivery') && s.lastEventAt) {
    out.push({
      id: 'stale',
      base: 'stale',
      dueAt: new Date(s.lastEventAt.getTime() + s.staleAfterHours * HOUR),
      effect: {
        kind: 'chase_carrier',
        label: `No update for ${Math.round(s.staleAfterHours / 24)} days — ask Correos`,
      },
    });
  }

  for (const x of s.extras) {
    out.push({ id: x.rungId, base: x.kind, dueAt: x.dueAt, effect: extraEffect(x.kind, s) });
  }

  return out
    .filter((r) => !s.fired.has(r.id))
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

function extraEffect(kind: ExtraKind, s: LadderInput): RungEffect {
  switch (kind) {
    case 'recheck':
      return {
        kind: 'call_task',
        reason: 'said_would_collect',
        label: 'Said they would pick it up, still not collected',
      };
    case 'retry':
      return {
        kind: 'call_task',
        reason: 'no_answer_yesterday',
        label: 'Try again — no answer yesterday',
      };
    case 'nochk':
      return {
        kind: 'call_task',
        reason: 'no_reply_to_message',
        label: 'No reply to the message — call them',
      };
  }
}

/**
 * Rungs due now. A muted shipment stays quiet — except for the re-check that
 * the mute itself booked, which is the whole point of muting it.
 */
export function dueRungs(s: LadderInput, at: Date): DueRung[] {
  const pending = pendingRungs(s).filter((r) => r.dueAt.getTime() <= at.getTime());
  if (s.mutedUntil && s.mutedUntil.getTime() > at.getTime()) {
    return pending.filter((r) => r.base === 'recheck');
  }
  return pending;
}

/** The next few things that will happen on their own. Shown on the parcel page. */
export function upcomingPlan(s: LadderInput, at: Date, limit = 4): DueRung[] {
  return pendingRungs(s)
    .filter((r) => r.dueAt.getTime() >= at.getTime())
    .slice(0, limit);
}

/**
 * Messages only go out when a person would not mind being messaged. The
 * prototype's clock jumped in whole days and never landed at 04:00; a real one
 * does, every night, and a WhatsApp at four in the morning about a parcel is
 * how a send-only number gets reported.
 */
export const QUIET_HOURS_START = 21;
export const QUIET_HOURS_END = 9;

export function withinSendingHours(at: Date): boolean {
  const h = madridParts(at).hour;
  return h >= QUIET_HOURS_END && h < QUIET_HOURS_START;
}

/** The next moment it is polite to send. Same instant if it already is. */
export function nextSendingSlot(at: Date): Date {
  if (withinSendingHours(at)) return at;
  const p = madridParts(at);
  const dayOffset = p.hour >= QUIET_HOURS_START ? 1 : 0;
  return new Date(madridMidnightUtc(p.year, p.month, p.day + dayOffset).getTime() + QUIET_HOURS_END * HOUR);
}
