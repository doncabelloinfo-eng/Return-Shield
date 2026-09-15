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
export async function say(text: string, shipmentId?: string, kind = 'system'): Promise<void> {
  await getDb().insert(activity).values({ at: now(), text, shipmentId: shipmentId ?? null, kind });
}

export async function recentActivity(limit = 24) {
  return getDb().select().from(activity).orderBy(desc(activity.at)).limit(limit);
}
