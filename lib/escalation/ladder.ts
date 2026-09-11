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
  // At the office, counted backwards from the deadline D.
  | 'o15' | 'o12' | 'o8' | 'o4' | 'o2' | 'o0'
  // Nothing from Correos for too long.
  | 'stale';

export type ExtraKind = 'recheck' | 'retry' | 'nochk';

export type RungEffect =
  /** Write a message: sent in Step 2, put in front of an operator in Step 1. */
  | { kind: 'message'; template: MessageTemplate }
  /** Put it on someone's call list. */
  | { kind: 'call_task'; reason: string; label: string }
  /** Ask Correos what happened. */
  | { kind: 'chase_carrier'; label: string }
  /** Correos normally has it at the office by now; go and look. */
  | { kind: 'expect_at_office' }
  /** The deposit window is up. Flag it and tell the office. */
  | { kind: 'deadline_reached' };

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
  officeArrivedAt: Date | null;
  officeDeadline: Date | null;
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
  o4: 'Four days left warning',
  o2: 'Last warning plus a call you cannot skip',
  o0: 'Correos sends it back to us',
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
  o0: { kind: 'deadline_reached' },
};

/** Rungs a `delivered`, `collected` or customer reply silences. */
export const SILENCEABLE: readonly RungId[] = ['f15', 'f4h', 'f24', 'f48', 'o15', 'o12', 'o8', 'o4', 'stale'];
/** The two that survive a "they said they'd collect it" — they are the backstop. */
export const FINAL_RUNGS: readonly RungId[] = ['o2', 'o0'];

/** Days before the deadline that each office rung fires. */
const OFFICE_OFFSETS: readonly { id: Exclude<RungId, 'stale'>; days: number }[] = [
  { id: 'o15', days: 15 },
  { id: 'o12', days: 12 },
  { id: 'o8', days: 8 },
  { id: 'o4', days: 4 },
  { id: 'o2', days: 2 },
  { id: 'o0', days: 0 },
];

/**
 * When an office rung is due: the start of the day that has N days left.
 *
 * Counting in calendar days rather than subtracting N×24h from the deadline
 * instant matters twice a year, and it also means "4 days left" always lands
 * on the morning of the day it is true — not at whatever o'clock the parcel
 * happened to reach the counter a fortnight earlier.
 */
export function officeRungDueAt(deadline: Date, daysBefore: number): Date {
  const p = madridParts(deadline);
  return madridMidnightUtc(p.year, p.month, p.day - daysBefore);
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

  if (s.state === 'at_office' && s.officeDeadline && s.officeArrivedAt) {
    const arrived = s.officeArrivedAt.getTime();
    for (const { id, days } of OFFICE_OFFSETS) {
      const natural = officeRungDueAt(s.officeDeadline, days);

      if (id === 'o15') {
        // The office-details message must always go out, even when the deposit
        // window is shorter than fifteen days and its natural slot is in the
        // past. A customer who is never told where the parcel is cannot
        // collect it. Every other rung keeps the guard below.
        out.push({
          id,
          base: id,
          dueAt: natural.getTime() < arrived ? s.officeArrivedAt : natural,
          effect: EFFECTS[id],
        });
        continue;
      }

      // A rung whose moment passed before the parcel even arrived never fires.
      // This is what makes cutting the deposit days behave like real life:
      // the early reminders are simply gone, the late ones still land.
      if (natural.getTime() < arrived) continue;
      out.push({ id, base: id, dueAt: natural, effect: EFFECTS[id] });
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
