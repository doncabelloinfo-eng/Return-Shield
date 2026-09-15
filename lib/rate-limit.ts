import { and, eq, lt, sql as raw } from 'drizzle-orm';
import { getDb } from '@/db';
import { actionRateLimit } from '@/db/schema';
import { now } from '@/lib/clock';

/**
 * Per-IP limiting for the one route with no login.
 *
 * Counted in the database rather than in memory, because the limit has to hold
 * across however many processes are serving the page — an in-memory counter on
 * three instances is three times the limit.
 */
const WINDOW_MINUTES = 10;

export async function rateLimit(ip: string, max: number): Promise<{ ok: boolean; hits: number }> {
  const at = now();
  const bucket = new Date(Math.floor(at.getTime() / (WINDOW_MINUTES * 60_000)) * WINDOW_MINUTES * 60_000);

  const [row] = await getDb().insert(actionRateLimit)
    .values({ ip, windowStart: bucket, hits: 1 })
    .onConflictDoUpdate({
      target: [actionRateLimit.ip, actionRateLimit.windowStart],
      set: { hits: raw`${actionRateLimit.hits} + 1` },
    })
    .returning({ hits: actionRateLimit.hits });

  return { ok: row.hits <= max, hits: row.hits };
}

/** Old buckets are noise. The nightly job clears them. */
export async function purgeRateLimits(): Promise<number> {
  const cutoff = new Date(now().getTime() - 24 * 60 * 60 * 1000);
  const gone = await getDb().delete(actionRateLimit)
    .where(lt(actionRateLimit.windowStart, cutoff))
    .returning({ ip: actionRateLimit.ip });
  return gone.length;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
