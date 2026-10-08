import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
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
  /**
   * 1 = messages are written for a person to send; 2 = they send themselves.
   *
   * Still stored, still read by `lib/escalation/run.ts`, and no longer
   * settable from any screen: sending itself also needs a WhatsApp provider
   * that can send, and there is none, so the switch that used to flip this
   * changed a number and nothing else. See app/actions/settings.ts.
   */
  phase: 1 | 2;
  /** How long Correos may say nothing before we ask where the parcel is. */
  staleAfterHours: number;
  /** A postcode is "watched" once it fails this much more than average. */
  watchFailRateMultiple: number;
  /** Demo mode only: minutes added to the real clock. */
  demoClockOffsetMinutes: number;
  /**
   * What we have learnt about Correos' undocumented multi-code format.
   *
   * 'unknown' means probe it; 'comma' means comma-separated works; 'single'
   * means it does not and every parcel needs its own request. Stored rather
   * than held in memory because serverless instances are short-lived and
   * numerous — an in-memory answer would be re-probed by every cold start, and
   * the operator could not see which mode is in use.
   */
  correosBatchMode: 'unknown' | 'comma' | 'single';
  /**
   * The largest number of codes per request Correos has actually accepted.
   *
   * 0 = never established, 1 = one parcel per request. Stored rather than
   * re-probed because probing costs a refused request, and because the
   * operator can see on the Settings screen what the sweep is working with.
   *
   * It replaces a verdict that used to be binary: a refused batch dropped
   * straight to one request per parcel, for good. On production a batch of 75
   * was refused with an HTML 403, so every one of 201 parcels got its own
   * request — and nobody knew whether 37 would have worked.
   */
  correosBatchSize: number;
  /**
   * When a larger batch was last tried, ISO. Empty means never.
   *
   * A gateway's limit is not a law of nature: it changes when Correos change
   * it, and a size written down for good would never be revisited. So once a
   * day the sweep tries double what it knows works, and if that is refused it
   * costs one request and goes back to the known size.
   */
  correosBatchProbedAt: string;
  /**
   * What the sweep running right now has got through, for the progress bar.
   *
   * In settings rather than a table of its own: it is one row that is
   * overwritten, never queried across, and this way the progress bar needed no
   * migration. See lib/sweep-progress.ts, which owns the shape.
   */
  sweepProgress: SweepProgress | null;
}

/**
 * One sweep's progress. Written by `reconcile` at most every two seconds and
 * read by the poll route, so both the manual Refresh and the hourly cron are
 * visible to anyone with the app open. See lib/sweep-progress.ts.
 */
export interface SweepProgress {
  /** Parcels this run set out to check. */
  total: number;
  /** Parcels it has had an answer about. */
  checked: number;
  /** Of those, how many Correos told us something new about. */
  changed: number;
  /** ISO. When the run started. */
  startedAt: string;
  /** ISO. When this row was last written — how the reader spots a dead run. */
  updatedAt: string;
  /** A person pressed Refresh, rather than the hourly cron. */
  manual: boolean;
  /** The run has finished. The final line stays on screen for a while. */
  done: boolean;
  /** Set when it stopped at its budget, with however many were left. */
  stoppedEarly?: string;
  /** Wall-clock milliseconds, on the final write. */
  tookMs?: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  phase: 1,
  // The written spec says 72 hours; the prototype's screen said five days.
  // 72 is the number that was stated twice, so it wins — and it lives here so
  // it can be changed in one place rather than argued about in two.
  staleAfterHours: 72,
  watchFailRateMultiple: 2,
  demoClockOffsetMinutes: 0,
  correosBatchMode: 'unknown',
  correosBatchSize: 0,
  correosBatchProbedAt: '',
  sweepProgress: null,
};

export async function getSettings(): Promise<AppSettings> {
  const rows = await getDb().select().from(settings);
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in out) {
      (out as Record<string, unknown>)[row.key] = row.value as unknown;
    }
  }
  return out;
}

export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  return (row?.value as AppSettings[K]) ?? DEFAULT_SETTINGS[key];
}

export async function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await getDb().insert(settings)
    .values({ key, value: value as unknown as object, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as unknown as object, updatedAt: new Date() },
    });
}
