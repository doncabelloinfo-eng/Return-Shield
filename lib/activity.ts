import { desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { activity } from '@/db/schema';
import { now } from '@/lib/clock';

/**
 * "What the system just did" — the running commentary across the top of every
 * screen. It exists so nobody ever has to wonder whether the thing that was
 * supposed to happen on its own actually happened.
 *
 * Every line is written the way you would say it to a colleague, and every
 * line says what it meant, not what changed in the database.
 */

export interface SayOptions {
  shipmentId?: string;
  kind?: string;
  /**
   * Set this when the line describes something that happened exactly once, so
   * two concurrent job runs cannot narrate it twice.
   *
   * It must be stable across the two runs and different for the next genuinely
   * new event — `at-office:<shipmentId>:<arrivalIso>` rather than anything
   * containing the current time, which would defeat it entirely.
   *
   * Leave it unset for anything genuinely repeatable: an operator restocking
   * the same parcel twice is two events, and collapsing them would be a lie.
   */
  dedupeKey?: string;
}

export async function say(
  text: string,
  shipmentIdOrOptions?: string | SayOptions,
  kind = 'system',
): Promise<void> {
  const opts: SayOptions = typeof shipmentIdOrOptions === 'string'
    ? { shipmentId: shipmentIdOrOptions, kind }
    : { kind, ...(shipmentIdOrOptions ?? {}) };

  await getDb().insert(activity).values({
    at: now(),
    text,
    shipmentId: opts.shipmentId ?? null,
    kind: opts.kind ?? 'system',
    dedupeKey: opts.dedupeKey ?? null,
  }).onConflictDoNothing({ target: activity.dedupeKey });
}

export async function recentActivity(limit = 24) {
  return getDb().select().from(activity).orderBy(desc(activity.at)).limit(limit);
}
