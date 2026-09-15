import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { escalationExtras, escalationFires } from '@/db/schema';
import { now } from '@/lib/clock';
import { FINAL_RUNGS, SILENCEABLE } from './ladder';

/**
 * Stop the ladder.
 *
 * `keepFinal` is the difference between "this parcel is finished" and "the
 * customer says they will sort it". A customer who promised to collect it
 * should not get four more reminders — but the last warning and the return
 * alert must still be there, because promises are not collections. Silencing
 * those too is how a parcel goes back without anybody noticing.
 */
export async function silence(
  shipmentId: string,
  opts: { keepFinal: boolean } = { keepFinal: false },
): Promise<void> {
  const rungs = opts.keepFinal ? SILENCEABLE : [...SILENCEABLE, ...FINAL_RUNGS];

  await getDb().insert(escalationFires)
    .values(rungs.map((rungId) => ({ shipmentId, rungId, silencedAt: now() })))
    .onConflictDoNothing();

  if (opts.keepFinal) {
    // The follow-ups the engine booked for itself are part of the noise, with
    // one exception: a re-check scheduled by this very outcome is the backstop.
    await getDb().delete(escalationExtras).where(and(
      eq(escalationExtras.shipmentId, shipmentId),
      notInArray(escalationExtras.kind, ['recheck']),
    ));
  } else {
    await getDb().delete(escalationExtras).where(eq(escalationExtras.shipmentId, shipmentId));
  }
}

/** This rung has now happened and must never happen again. */
export async function markFired(shipmentId: string, rungId: string): Promise<void> {
  await getDb().insert(escalationFires)
    .values({ shipmentId, rungId, firedAt: now() })
    .onConflictDoNothing();
  await getDb().delete(escalationExtras).where(and(
    eq(escalationExtras.shipmentId, shipmentId),
    eq(escalationExtras.rungId, rungId),
  ));
}

/** Book a follow-up for the engine itself. */
export async function scheduleExtra(
  shipmentId: string,
  kind: 'recheck' | 'retry' | 'nochk',
  dueAt: Date,
): Promise<string> {
  // One of each kind in flight per shipment: booking "try again tomorrow"
  // twice should mean one call tomorrow, not two.
  await getDb().delete(escalationExtras).where(and(
    eq(escalationExtras.shipmentId, shipmentId),
    eq(escalationExtras.kind, kind),
  ));

  const rungId = `${kind}-${dueAt.getTime()}`;
  await getDb().insert(escalationExtras)
    .values({ shipmentId, rungId, kind, dueAt, createdAt: now() })
    .onConflictDoNothing();

  // If this exact rung fired before, let it fire again — it is a new booking.
  await getDb().delete(escalationFires).where(and(
    eq(escalationFires.shipmentId, shipmentId),
    eq(escalationFires.rungId, rungId),
  ));

  return rungId;
}

/** Let silenced rungs run again. Used when a fresh failure restarts the ladder. */
export async function unsilence(shipmentId: string, rungs: readonly string[]): Promise<void> {
  if (!rungs.length) return;
  await getDb().delete(escalationFires).where(and(
    eq(escalationFires.shipmentId, shipmentId),
    inArray(escalationFires.rungId, rungs as string[]),
  ));
}
