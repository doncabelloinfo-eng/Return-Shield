/**
 * The four outcomes, in the order the keyboard shortcuts use.
 *
 * Kept apart from outcomes.ts so a client component can import the list
 * without dragging the database into the browser bundle.
 */
export const CALL_OUTCOMES = [
  'Will pick it up',
  'Wants new address',
  "Didn't pick up",
  "Doesn't want it",
] as const;

export type CallOutcome = typeof CALL_OUTCOMES[number];

export function isCallOutcome(x: string): x is CallOutcome {
  return (CALL_OUTCOMES as readonly string[]).includes(x);
}
