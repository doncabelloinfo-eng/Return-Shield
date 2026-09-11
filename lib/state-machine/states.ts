/**
 * Exactly the prototype's state names, so every screen ports unchanged.
 *
 * `created` is the row before Correos has said anything. `stale` is not a
 * Correos state at all — it is derived when nothing has arrived for longer
 * than the configured silence, and it never overwrites a real state.
 */
export const SHIPMENT_STATES = [
  'created',
  'accepted',
  'in_transit',
  'out_for_delivery',
  'failed',
  'at_office',
  'collected',
  'delivered',
  'returning',
  'returned',
  'bad_address',
  'refused',
  'stale',
] as const;

export type ShipmentState = typeof SHIPMENT_STATES[number];

export function isShipmentState(x: string): x is ShipmentState {
  return (SHIPMENT_STATES as readonly string[]).includes(x);
}

/** Nothing more will happen on its own. The ladder stops here. */
export const TERMINAL_STATES: ReadonlySet<ShipmentState> = new Set<ShipmentState>([
  'delivered', 'collected', 'returned',
]);

/** The parcel is coming back or is already back; the job is to receive it. */
export const RETURN_STATES: ReadonlySet<ShipmentState> = new Set<ShipmentState>([
  'returning', 'returned', 'refused',
]);

/** Moving normally. Nothing to do unless it goes quiet. */
export const IN_FLIGHT_STATES: ReadonlySet<ShipmentState> = new Set<ShipmentState>([
  'accepted', 'in_transit', 'out_for_delivery',
]);

/** A happy ending: the customer has the parcel. */
export const SAVED_STATES: ReadonlySet<ShipmentState> = new Set<ShipmentState>([
  'delivered', 'collected',
]);

/**
 * States we still chase. Anything not here is either finished or waiting on
 * the warehouse rather than on the customer.
 */
export function isLive(state: ShipmentState): boolean {
  return !TERMINAL_STATES.has(state);
}
