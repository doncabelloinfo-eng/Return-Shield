import type { ShipmentState } from './states';
import { applyEvent } from './transitions';
import { deadlineFrom } from '@/lib/time';
import { HOUR } from '@/lib/clock';

/**
 * The projection. Given every event a shipment has ever had, work out where it
 * is now. Pure: no clock, no database, no surprises — which is what makes it
 * safe to replay the whole table after fixing a normaliser bug.
 */

export interface ProjectableEvent {
  eventCode: string;
  eventDesc: string;
  occurredAt: Date;
  mappedState: ShipmentState | null;
  officeCode?: string | null;
  officeName?: string | null;
}

export interface Projection {
  state: ShipmentState;
  stateSince: Date | null;
  /** When it arrived at the post office the countdown is running against. */
  officeArrivedAt: Date | null;
  officeCode: string | null;
  officeName: string | null;
  officeDeadline: Date | null;
  /** The most recent failed delivery. The first four rungs hang off this. */
  failedAt: Date | null;
  /** Newest event of any kind, mapped or not. Silence is measured from here. */
  lastEventAt: Date | null;
  eventCount: number;
  /** Events Correos sent that we have no mapping for. */
  unmappedCount: number;
}

export interface ProjectOptions {
  /** From product_rules. Never defaulted to 15 by accident — see callers. */
  depositDays: number;
}

/**
 * Sorting is by `occurredAt`, with the event code as a tiebreak so two events
 * stamped the same second always land in the same order — otherwise replaying
 * the same table twice could produce two different answers.
 */
function byOccurrence(a: ProjectableEvent, b: ProjectableEvent): number {
  const d = a.occurredAt.getTime() - b.occurredAt.getTime();
  return d !== 0 ? d : a.eventCode.localeCompare(b.eventCode);
}

export function project(events: readonly ProjectableEvent[], opts: ProjectOptions): Projection {
  const ordered = [...events].sort(byOccurrence);

  let state: ShipmentState = 'created';
  let stateSince: Date | null = null;
  let officeArrivedAt: Date | null = null;
  let officeCode: string | null = null;
  let officeName: string | null = null;
  let failedAt: Date | null = null;
  let lastEventAt: Date | null = null;
  let unmappedCount = 0;

  for (const ev of ordered) {
    if (!lastEventAt || ev.occurredAt > lastEventAt) lastEventAt = ev.occurredAt;
    if (ev.mappedState === null) { unmappedCount += 1; continue; }

    const next = applyEvent(state, ev.mappedState);
    if (next !== state) {
      state = next;
      stateSince = ev.occurredAt;
    }

    // These two are remembered even when the state has moved on since, because
    // the countdown and the post-failure ladder are both anchored to them.
    if (ev.mappedState === 'at_office') {
      officeArrivedAt = ev.occurredAt;
      officeCode = ev.officeCode ?? officeCode;
      officeName = ev.officeName ?? officeName;
    }
    if (ev.mappedState === 'failed') failedAt = ev.occurredAt;
  }

  // A parcel that left the office is no longer counting down.
  const stillAtOffice = state === 'at_office';
  const officeDeadline = stillAtOffice && officeArrivedAt
    ? deadlineFrom(officeArrivedAt, opts.depositDays)
    : null;

  return {
    state,
    stateSince,
    officeArrivedAt,
    officeCode,
    officeName,
    officeDeadline,
    failedAt,
    lastEventAt,
    eventCount: ordered.length,
    unmappedCount,
  };
}

/**
 * Silence, not a state change. A parcel Correos has said nothing about for
 * longer than `afterHours` is worth asking about — the events stop arriving
 * long before anybody notices the parcel is missing.
 *
 * Only applies to parcels in motion. A parcel sitting at a post office is
 * *expected* to be silent for a fortnight; flagging that would bury the ones
 * that genuinely vanished.
 */
export function isStale(p: Projection, at: Date, afterHours: number): boolean {
  if (!p.lastEventAt) return false;
  if (p.state !== 'accepted' && p.state !== 'in_transit' && p.state !== 'out_for_delivery') {
    return false;
  }
  return at.getTime() - p.lastEventAt.getTime() > afterHours * HOUR;
}
