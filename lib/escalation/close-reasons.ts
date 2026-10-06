/**
 * Why a parcel was closed by hand.
 *
 * Kept apart from outcomes.ts so a client component and `db/schema.ts` can
 * both import the list without dragging the database into the browser bundle
 * — the same reason outcome-names.ts exists.
 *
 * The reason is required. Before this, "Stop chasing this one" wrote a
 * timestamp and nothing else, so the system could say how many parcels had
 * been given up on and never why: a parcel Correos lost and a parcel the
 * customer was holding all along looked identical a month later.
 *
 * The labels are English because the operator reads English. The stored value
 * is the key, not the label, so the wording can be improved without a
 * migration.
 */
export const CLOSE_REASONS = {
  lost: {
    label: 'Lost',
    hint: 'Correos lost it, or it never turned up.',
  },
  delivered_by_hand: {
    label: 'Delivered (confirmed by hand)',
    hint: 'The customer has it, but Correos never said so.',
  },
  returned_received: {
    label: 'Returned (received back)',
    hint: 'It is back in the warehouse.',
  },
  other: {
    label: 'Other',
    hint: 'A note is required.',
  },
} as const;

export type CloseReason = keyof typeof CLOSE_REASONS;

export const CLOSE_REASON_KEYS = Object.keys(CLOSE_REASONS) as CloseReason[];

export function isCloseReason(x: string): x is CloseReason {
  return x in CLOSE_REASONS;
}

export function closeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'No reason recorded';
  return isCloseReason(reason) ? CLOSE_REASONS[reason].label : reason;
}

/** `other` is the only reason that cannot stand on its own. */
export function noteRequiredFor(reason: CloseReason): boolean {
  return reason === 'other';
}
