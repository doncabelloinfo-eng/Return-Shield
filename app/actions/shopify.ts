'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { stores } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { pullStore, type PullReport } from '@/lib/carriers/shopify/pull';
import {
  applyTikTokHandover, previewTikTokHandover,
  type HandoverPreview, type HandoverResult,
} from '@/lib/orders/tiktok-handover';

/**
 * "Pull the last 30 days", per Shopify store.
 *
 * Two actions rather than one, and that is the point: the pull creates the
 * parcels and a SECOND request asks Correos about them. Both are bounded by
 * the same 300-second function limit, so doing the sweep inside the pull would
 * mean the sweep gets whatever seconds the pull left over — which on a
 * thousand parcels is none.
 *
 * Without that second step a thousand freshly pulled parcels sit in
 * Pre-admission until the next scheduled sweep, up to three hours later. For
 * the ones already waiting at a post office that is three hours of a countdown
 * nobody can see.
 */

export interface PullResult {
  ok: boolean;
  error?: string;
  report?: PullReport;
}

export async function pullShopifyHistory(storeKey: string): Promise<PullResult> {
  await requireUser();

  const [store] = await getDb().select().from(stores)
    .where(and(eq(stores.key, storeKey), eq(stores.platform, 'shopify')))
    .limit(1);

  if (!store) return { ok: false, error: `No Shopify shop with the key "${storeKey}".` };

  try {
    const report = await pullStore(storeKey, { budgetMs: 240_000 });
    revalidatePath('/', 'layout');
    return { ok: true, report };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'The pull did not finish.' };
  }
}

/*
 * The second step — asking Correos about the parcels the pull just created —
 * now lives in app/actions/refresh.ts as `sweepNewParcels`, because the
 * confirmed upload of a TikTok or Amazon file needs exactly the same thing and
 * two copies of it would drift. It takes the same `job_locks` row as the
 * Refresh button and the cron, so none of the three can overlap.
 */
// (not re-exported from here: a "use server" file may only export async
// functions, so the one import site reaches for it directly.)

/* ------------------------------------- the TikTok orders already pulled in */

/*
 * Re-exported so the component imports one module rather than two. Type-only,
 * which a `'use server'` file is allowed to export — see
 * tests/use-server-exports.test.ts, which is the guard for the day a value
 * export here crashed every screen.
 */
export type { HandoverPreview, HandoverResult };

export interface HandoverPreviewResult {
  ok: boolean;
  error?: string;
  preview?: HandoverPreview;
}

export interface HandoverApplyResult {
  ok: boolean;
  error?: string;
  result?: HandoverResult;
}

/**
 * "What would move?" Nothing is written.
 *
 * Separate from the apply because this one is safe to press out of curiosity,
 * and because the operator should see the three numbers before committing to
 * them — the numbers come from the same query the apply uses, so what the
 * preview promises is what the apply does. See lib/orders/tiktok-handover.ts.
 */
export async function previewTikTokOrders(): Promise<HandoverPreviewResult> {
  await requireUser();
  try {
    return { ok: true, preview: await previewTikTokHandover() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not read the orders.' };
  }
}

/**
 * Move them: each parcel to its TikTok order, each emptied Shopify row gone.
 *
 * Safe to press twice — the second press finds nothing, because the rows it
 * works from are Shopify orders carrying a TikTok tag and it has just removed
 * them all.
 */
export async function moveTikTokOrders(): Promise<HandoverApplyResult> {
  await requireUser();
  try {
    const result = await applyTikTokHandover();
    revalidatePath('/', 'layout');
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'The move did not finish.' };
  }
}
