import type { ShipmentState } from '@/lib/state-machine/states';
import { RETURN_STATES } from '@/lib/state-machine/states';
import { daysLeft } from '@/lib/time';
import { now } from '@/lib/clock';

/**
 * What matters most, and the one thing to do about it.
 *
 * Two rules run this screen:
 *   · order by money at risk, not only by days left — a cash-on-delivery
 *     parcel worth €148 with four days left outranks a €28 prepaid one with
 *     two, because losing it costs the whole sale rather than the margin;
 *   · one decided action per row. If the system can work out what to do, it
 *     says what to do. Everything else lives behind the ⋯.
 */

export type TaskType = 'call' | 'contact' | 'address_fix' | 'chase_carrier' | 'receive_return' | 'insight';

export interface OpenTask {
  type: TaskType;
  reason: string;
  label: string;
}

export interface DecidableShipment {
  id: string;
  state: ShipmentState;
  officeDeadline: Date | null;
  officeName: string | null;
  town: string;
  customerName: string;
  valueCents: number;
  paymentMethod: 'prepaid' | 'cod';
  dropped: boolean;
  restocked: boolean;
  redirectPending: boolean;
  mutedUntil: Date | null;
  openTasks: readonly OpenTask[];
  lastContactOutcome: string | null;
}

/* -------------------------------------------------------------------------- */

/**
 * Money genuinely at risk if this parcel goes back.
 *
 * On cash on delivery the whole sale is lost — nothing was ever collected. On
 * a prepaid order the money is already in, so what is at risk is the refund
 * plus both legs of postage and the fortnight the stock spent in a sorting
 * office; that lands near half the order value, hence 0.55.
 */
export function riskCents(s: Pick<DecidableShipment, 'valueCents' | 'paymentMethod'>): number {
  return s.paymentMethod === 'cod' ? s.valueCents : Math.round(s.valueCents * 0.55);
}

/**
 * The ordering score. Higher goes first.
 *
 * Days left bend the money, they do not replace it: a parcel with two days
 * left doubles, one out of time triples. A parcel already coming back is worth
 * half — the money is lost either way, what is left is getting the stock back.
 */
export function priority(s: DecidableShipment, at: Date = now()): number {
  const risk = riskCents(s);
  if (RETURN_STATES.has(s.state)) return risk * 0.5;

  const d = daysLeft(s.officeDeadline, at);
  if (d === null) return risk * 0.7;

  let score = risk * (0.4 + Math.max(0, 16 - d) / 16);
  if (d <= 2) score *= 2;
  if (d <= 0) score *= 3;
  return score;
}

export function money(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/**
 * The line under the row that says why this one is at the top. Never make
 * somebody work out the ordering themselves.
 */
export function reason(s: DecidableShipment, at: Date = now()): string {
  const d = daysLeft(s.officeDeadline, at);
  const bits: string[] = [];
  if (d !== null && d <= 2) bits.push(d <= 0 ? 'out of time' : `${d} days left`);
  bits.push(s.paymentMethod === 'cod'
    ? `${money(s.valueCents)}, cash on delivery`
    : `${money(s.valueCents)} prepaid`);
  if (s.lastContactOutcome === "Didn't pick up") bits.push('never answered');
  return `Top of the list: ${bits.join(' · ')}.`;
}

/* -------------------------------------------------------------------------- */

export type ActionTone = 'navy' | 'warn' | 'confirm';

export interface NextAction {
  /** What the button says. */
  label: string;
  /** The sentence underneath: why this, now. */
  why: string;
  /** What tapping it does. */
  kind: 'restock' | 'send_redirect' | 'chase_carrier' | 'rebook_delivery' | 'confirm_address' | 'go_to_calls';
  tone: ActionTone;
  /** Costs money or cannot be undone, so it asks twice. */
  needsConfirm: boolean;
}

/**
 * The one decided action. Order matters: the first branch that matches wins,
 * and the branches are in the order a person would actually deal with them.
 */
export function nextAction(s: DecidableShipment, at: Date = now()): NextAction | null {
  if (s.dropped) return null;

  const has = (t: TaskType) => s.openTasks.some((x) => x.type === t);
  const task = (t: TaskType) => s.openTasks.find((x) => x.type === t);

  // It is physically coming back. The only useful thing left is the stock.
  if (RETURN_STATES.has(s.state) && !s.restocked) {
    return {
      label: 'Put back in stock',
      why: s.state === 'returning'
        ? `Time ran out at ${s.officeName ?? 'the post office'}`
        : "Customer didn't want it",
      kind: 'restock',
      tone: 'navy',
      needsConfirm: false,
    };
  }

  // Correos charges for a redirection, so this one always asks twice.
  if (s.redirectPending) {
    return {
      label: 'Send new address to Correos',
      why: 'They asked for a different address',
      kind: 'send_redirect',
      tone: 'confirm',
      needsConfirm: true,
    };
  }

  const chase = task('chase_carrier');
  if (chase) {
    return { label: 'Ask Correos about this one', why: chase.label, kind: 'chase_carrier', tone: 'navy', needsConfirm: false };
  }

  const fix = task('address_fix');
  if (fix) {
    const label = fix.reason === 'address_confirmed' ? 'Book another delivery' : 'Fix address with Correos';
    return { label, why: fix.label, kind: 'rebook_delivery', tone: 'navy', needsConfirm: false };
  }

  // Before anything has gone wrong: this postcode fails far more than average.
  // Preventing one failed delivery beats rescuing three.
  const insight = task('insight');
  if (insight) {
    return {
      label: 'Confirm the address now',
      why: `${s.town.split(',')[0]} fails far more than average`,
      kind: 'confirm_address',
      tone: 'warn',
      needsConfirm: false,
    };
  }

  if (has('call') || has('contact')) {
    const base = task('call')?.label ?? task('contact')?.label ?? '';
    const d = daysLeft(s.officeDeadline, at);
    const suffix = d !== null ? ` · ${d} ${d === 1 ? 'day left' : 'days left'}` : '';
    return {
      label: `Call ${firstName(s.customerName)}`,
      why: base + suffix,
      kind: 'go_to_calls',
      tone: 'navy',
      needsConfirm: false,
    };
  }

  return null;
}

/** Quiet until a re-check — on nobody's list in the meantime. */
export function isSnoozed(s: Pick<DecidableShipment, 'mutedUntil'>, at: Date = now()): boolean {
  return s.mutedUntil !== null && s.mutedUntil.getTime() > at.getTime();
}

/** Everything genuinely waiting on a person, most money at risk first. */
export function actionable<T extends DecidableShipment>(list: readonly T[], at: Date = now()): T[] {
  return list
    .filter((s) => !isSnoozed(s, at) && nextAction(s, at) !== null)
    .sort((a, b) => priority(b, at) - priority(a, at));
}

/** The call list: only parcels where the next step is to pick up the phone. */
export function callQueue<T extends DecidableShipment>(list: readonly T[], at: Date = now()): T[] {
  return list
    .filter((s) => !s.dropped && !isSnoozed(s, at)
      && s.openTasks.some((t) => t.type === 'call' || t.type === 'contact'))
    .sort((a, b) => priority(b, at) - priority(a, at));
}

/* -------------------------------------------------------------------------- */

export type Tone = 'calm' | 'warn' | 'crit' | 'ret';

/** How loud a row should be. Drives colour, weight and the left stripe. */
export function tone(state: ShipmentState, deadline: Date | null, at: Date = now()): Tone {
  if (state === 'returning' || state === 'refused' || state === 'returned') return 'ret';
  const d = daysLeft(deadline, at);
  if (d === null) return 'calm';
  if (d <= 3) return 'crit';
  if (d <= 7) return 'warn';
  return 'calm';
}
