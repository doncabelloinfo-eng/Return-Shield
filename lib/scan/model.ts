/**
 * What the Scanner is, in the few words everything else shares.
 *
 * Types and labels only: no database, no React, so the phone bundle, the API
 * routes, the panel and the nightly cleanup can all import it.
 */

/** Out of the warehouse to a customer, or back from one. */
export type ScanDirection = 'outgoing' | 'incoming';
/** Read off the label by the camera, or typed in by hand. */
export type ScanSource = 'barcode' | 'typed';

export const SCAN_DIRECTIONS: readonly ScanDirection[] = ['outgoing', 'incoming'] as const;

export function isScanDirection(value: string | undefined | null): value is ScanDirection {
  return value === 'outgoing' || value === 'incoming';
}

/** The chip at the top of the phone, and the word in the batch summary. */
export const DIRECTION_LABEL: Record<ScanDirection, string> = {
  outgoing: 'Outgoing',
  incoming: 'Incoming',
};

export const DIRECTION_NOTE: Record<ScanDirection, string> = {
  outgoing: 'Parcels leaving the warehouse for customers',
  incoming: 'Parcels coming back to the warehouse',
};

/**
 * The badge a scan leaves on the parcel, in the panel.
 *
 * These two sentences are the whole of what a scan changes in Return Shield.
 * Nothing moves a parcel's state, closes it, or touches the escalation — a
 * parcel scanned back in is still being chased until Correos says it was
 * returned, because the warehouse opening a box is not Correos reporting it.
 */
export const DIRECTION_BADGE: Record<ScanDirection, string> = {
  outgoing: 'Left the warehouse',
  incoming: 'Back in the warehouse',
};

/**
 * How long a scan is kept: ninety days, by the nightly cleanup.
 *
 * Deliberately longer than the parcels' thirty-day window and deliberately
 * independent of it. A scan has no foreign key to `shipments`, so the parcel
 * cleanup cannot take one with it — which is the point: a return that arrives
 * on day 40 has to be able to say "this left the warehouse on day 2", and the
 * Returns tab has to keep showing it after the parcel itself has gone.
 */
export const SCAN_RETENTION_DAYS = 90;
