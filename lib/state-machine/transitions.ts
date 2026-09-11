import type { ShipmentState } from './states';
import { TERMINAL_STATES } from './states';

/**
 * Guards for applying one event to the current state.
 *
 * The rule is simple and deliberately so: the newest event wins. Push and
 * polling deliver the same events in different orders and at different times,
 * so "newest" means the latest `occurred_at` Correos gave us, never the order
 * we happened to receive them in. Everything else here is about the handful of
 * moves that would be wrong even if they arrived last.
 */

export interface TransitionDecision {
  accept: boolean;
  /** Why not, for the log. Never shown to an operator. */
  reason?: string;
}

/**
 * Can `next` follow `current`?
 *
 * The only hard refusals are moves away from a parcel the customer already
 * has. A `delivered` parcel that then reports `en reparto` is Correos
 * replaying an old scan, not the parcel coming back; accepting it would put a
 * finished order back on someone's call list.
 */
export function canTransition(current: ShipmentState, next: ShipmentState): TransitionDecision {
  if (current === next) return { accept: true };

  if (TERMINAL_STATES.has(current)) {
    // Once the customer has it, the only thing that can still happen is a
    // return — which does occur: refused at the door after a failed re-try,
    // or handed back at the counter.
    if (next === 'returning' || next === 'returned' || next === 'refused') return { accept: true };
    return { accept: false, reason: `${current} is finished; ignoring a later ${next}` };
  }

  // A parcel already on its way back does not go back out for delivery.
  if ((current === 'returning' || current === 'returned') && next !== 'returned') {
    return { accept: false, reason: `${current} is on its way back; ignoring ${next}` };
  }

  return { accept: true };
}

/**
 * Apply an event's mapped state. `null` — a code we have never seen — is not
 * an error and changes nothing.
 */
export function applyEvent(current: ShipmentState, mapped: ShipmentState | null): ShipmentState {
  if (mapped === null) return current;
  return canTransition(current, mapped).accept ? mapped : current;
}
