import type { ShipmentState } from '@/lib/state-machine/states';
import { RETURN_STATES } from '@/lib/state-machine/states';
import { daysAtOffice, OFFICE_CRIT_DAYS, OFFICE_WARN_DAYS } from '@/lib/time';
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
  /**
   * When Correos said it reached the counter.
   *
   * This used to be `officeDeadline`, a last day worked out from a deposit
   * window nobody had confirmed. Everything that read it — the ordering, the
   * colour of a row, the line under it — now reads the one date Correos
   * actually sends, and counts forward instead of down.
   */
  officeArrivedAt: Date | null;
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
 * Time at the office bends the money, it does not replace it: the longest-
 * waiting parcel outranks a slightly richer one that landed this morning. The
 * two multipliers are the days the last two reminders go out — at eleven days
 * the system has already written to the customer four times, at thirteen it is
 * the final one plus a call, and by then the parcel is the one to save.
 *
 * A parcel already coming back is worth half: the money is lost either way,
 * and what is left is getting the stock back.
 */
export function priority(s: DecidableShipment, at: Date = now()): number {
  const risk = riskCents(s);
  if (RETURN_STATES.has(s.state)) return risk * 0.5;

  const days = daysAtOffice(s.officeArrivedAt, at);
  if (days === null) return risk * 0.7;

  let score = risk * (0.4 + Math.min(16, days + 1) / 16);
  if (days >= OFFICE_CRIT_DAYS) score *= 2;
  if (days >= 13) score *= 3;
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
  const days = daysAtOffice(s.officeArrivedAt, at);
  const bits: string[] = [];
  if (days !== null && days >= OFFICE_CRIT_DAYS) {
    bits.push(`${days} ${days === 1 ? 'day' : 'days'} at the post office`);
  }
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
      /*
       * "Mark as", not "Put": all this does is record the restock here.
       * Shopify's inventory does not move, because the access token is
       * `read_orders` only — so a button that said "Put back in stock" was
       * promising something nobody had wired up.
       */
      label: 'Mark as back in stock',
      why: s.state === 'returning'
        ? `Correos is sending it back from ${s.officeName ?? 'the post office'}`
        : "Customer didn't want it",
      kind: 'restock',
      tone: 'navy',
      needsConfirm: false,
    };
  }

  /*
   * "Mark as sent", not "Send": nothing here talks to Correos.
   *
   * A redirection is arranged by a person, through Mi Oficina or on the
   * phone, and Correos charges for it. This button records that it has been
   * done, closes the task and takes the parcel off the list — which is real
   * and useful, and is not the same thing as the label "Send new address to
   * Correos" was claiming. It still asks twice, because closing that task is
   * not undoable, but the confirmation no longer pretends money is about to
   * be spent by the press itself.
   */
  if (s.redirectPending) {
    return {
      label: 'Mark new address as sent',
      why: 'They asked for a different address — Correos charges for a redirection',
      kind: 'send_redirect',
      tone: 'confirm',
      needsConfirm: true,
    };
  }

  // Same again: these record that a person asked Correos. Nothing in this
  // system can open a case with them.

  const chase = task('chase_carrier');
  if (chase) {
    return { label: 'Mark as asked Correos', why: chase.label, kind: 'chase_carrier', tone: 'navy', needsConfirm: false };
  }

  const fix = task('address_fix');
  if (fix) {
    const label = fix.reason === 'address_confirmed'
      ? 'Mark new delivery as booked'
      : 'Mark address as fixed with Correos';
    return { label, why: fix.label, kind: 'rebook_delivery', tone: 'navy', needsConfirm: false };
  }

  // Before anything has gone wrong: this postcode fails far more than average.
  // Preventing one failed delivery beats rescuing three.
  const insight = task('insight');
  if (insight) {
    return {
      // An instruction to a person, which is honest: they ring the customer.
      label: 'Confirm the address now',
      why: `${s.town.split(',')[0]} fails far more than average`,
      kind: 'confirm_address',
      tone: 'warn',
      needsConfirm: false,
    };
  }

  if (has('call') || has('contact')) {
    const base = task('call')?.label ?? task('contact')?.label ?? '';
    const days = daysAtOffice(s.officeArrivedAt, at);
    const suffix = days !== null
      ? ` · ${days} ${days === 1 ? 'day' : 'days'} at the post office`
      : '';
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

/**
 * How loud a row should be. Drives colour, weight and the left stripe.
 *
 * Red from eleven days at the office, amber from seven — the two days the
 * system writes to the customer again, so the screen goes louder on the same
 * day the parcel does.
 */
export function tone(state: ShipmentState, officeArrivedAt: Date | null, at: Date = now()): Tone {
  if (state === 'returning' || state === 'refused' || state === 'returned') return 'ret';
  const days = daysAtOffice(officeArrivedAt, at);
  if (days === null) return 'calm';
  if (days >= OFFICE_CRIT_DAYS) return 'crit';
  if (days >= OFFICE_WARN_DAYS) return 'warn';
  return 'calm';
}
