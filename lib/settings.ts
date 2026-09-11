import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { settings } from '@/db/schema';

/**
 * The handful of numbers that change how the system behaves, kept in the
 * database rather than in env so they can be changed from the Settings screen
 * without a deploy.
 *
 * The deposit window is NOT here — it lives in product_rules, per product code,
 * because Correos holds different services for different lengths of time.
 */

export interface AppSettings {
  /** Step 1 writes messages for a person; Step 2 sends them itself. */
  phase: 1 | 2;
  /** How long Correos may say nothing before we ask where the parcel is. */
  staleAfterHours: number;
  /** A postcode is "watched" once it fails this much more than average. */
  watchFailRateMultiple: number;
  /** Demo mode only: minutes added to the real clock. */
  demoClockOffsetMinutes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  phase: 1,
  // The written spec says 72 hours; the prototype's screen said five days.
  // 72 is the number that was stated twice, so it wins — and it lives here so
  // it can be changed in one place rather than argued about in two.
  staleAfterHours: 72,
  watchFailRateMultiple: 2,
  demoClockOffsetMinutes: 0,
};

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.select().from(settings);
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in out) {
      (out as Record<string, unknown>)[row.key] = row.value as unknown;
    }
  }
  return out;
}

export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return (row?.value as AppSettings[K]) ?? DEFAULT_SETTINGS[key];
}

export async function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await db.insert(settings)
    .values({ key, value: value as unknown as object, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as unknown as object, updatedAt: new Date() },
    });
}
