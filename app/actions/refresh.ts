'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/guard';
import { reconcile, runJob } from '@/jobs/definitions';
import { acquireJobLock, releaseJobLock, type Lease } from '@/lib/job-lock';
import { sweepStatus } from '@/lib/engine-health';
import { now, MINUTE } from '@/lib/clock';
import { agoInWords, human } from '@/lib/time';
import {
  MANUAL_SWEEP_GAP_MS, manualSweepBudgetMs, manualSweepLeaseSeconds, sweepResultLine,
} from '@/lib/refresh';

/**
 * "Refresh" — ask Correos now, rather than waiting up to three hours.
 *
 * It is the SAME sweep the cron runs, not a second one: the same `reconcile`
 * function, the same urgent-first cursor, the same `job_locks` row. That
 * matters twice over. Two sweeps running at once would spend the Correos quota
 * twice over on the same parcels and race each other's `last_reconciled_at`
 * stamps; and a button with a code path of its own is a code path that drifts
 * from the one that runs two hundred times a week.
 *
 * So the lock is the whole design. The button cannot run while the cron holds
 * it, the cron cannot start while the button holds it, and whichever loses
 * says so plainly instead of silently doing nothing.
 *
 * NOTHING BUT ASYNC FUNCTIONS AND TYPES IS EXPORTED FROM HERE. Next refuses to
 * load a `'use server'` module that exports anything else — not the one export,
 * the whole module — so a single exported constant took all three actions in
 * this file down with it. The constants and the pure helpers live in
 * lib/refresh.ts, and tests/use-server-exports.test.ts is what now catches it.
 */

export interface RefreshResult {
  ok: boolean;
  /** One line for the operator. Always set, success or not. */
  message: string;
  /** True when a sweep genuinely ran and asked Correos something. */
  swept: boolean;
}

export async function refreshFromCorreos(): Promise<RefreshResult> {
  await requireUser();

  const at = now();

  /*
   * The guard comes before the lock, and that order is fine here precisely
   * because it is a courtesy rather than a correctness rule: the lock is what
   * stops two sweeps overlapping. This only stops somebody pressing the button
   * twenty times in a minute and spending the Correos quota on parcels that
   * were up to date thirty seconds ago.
   */
  const status = await sweepStatus(at);
  if (status.lastManualAt && at.getTime() - status.lastManualAt.getTime() < MANUAL_SWEEP_GAP_MS) {
    const waitMs = MANUAL_SWEEP_GAP_MS - (at.getTime() - status.lastManualAt.getTime());
    const minutes = Math.max(1, Math.ceil(waitMs / MINUTE));
    return {
      ok: true,
      swept: false,
      message: `Already checked ${agoInWords(status.lastManualAt, at)}. `
        + `You can check again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    };
  }

  const lock = await acquireJobLock('reconcile', manualSweepLeaseSeconds());
  if (!lock.acquired) {
    return {
      ok: true,
      swept: false,
      message: lock.heldUntil
        ? `A check with Correos is already running — it should finish ${human(lock.heldUntil, at)}. `
          + 'Nothing is lost; try again in a moment.'
        : 'A check with Correos is already running. Nothing is lost; try again in a moment.',
    };
  }

  const lease: Lease = lock.lease;

  try {
    // Recorded as an ordinary `reconcile` run, flagged `manual`, so the
    // Scheduled jobs panel, the engine-health heartbeat and the five-minute
    // guard all see it without being taught about a second kind of sweep.
    const outcome = await runJob('reconcile', async () => {
      const result = await reconcile({ budgetMs: manualSweepBudgetMs() });
      return { ...result, detail: { ...result.detail, manual: true } };
    });

    revalidatePath('/', 'layout');

    if (!outcome.ok) {
      return {
        ok: false,
        swept: false,
        message: 'The check did not finish. The three-hourly sweep will try again — '
          + 'Settings shows what went wrong.',
      };
    }

    if (typeof outcome.detail.skipped === 'string') {
      return { ok: false, swept: false, message: String(outcome.detail.skipped) };
    }

    return { ok: true, swept: true, message: sweepResultLine(outcome.detail) };
  } finally {
    // Before anything else: a manual sweep that left the lock held would make
    // the next cron tick skip, and the operator would have made things worse
    // by pressing a button.
    await releaseJobLock(lease).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */

export interface SweepResult {
  ok: boolean;
  error?: string;
  /** Parcels asked about, and what came back. */
  detail?: Record<string, unknown>;
}

/**
 * Ask Correos about the parcels that have just arrived, and only those.
 *
 * Used twice: after a Shopify history pull, and after a confirmed upload of a
 * TikTok or Amazon tracking file. Without it, newly added parcels sit in
 * *Pre-admission* until the next scheduled sweep, up to three hours later —
 * and for one already waiting at a post office that is three hours of a
 * countdown nobody can see. The eighty-one TikTok parcels uploaded on
 * 7 October did exactly that.
 *
 * `onlyUnswept`, so it is the new parcels and nothing else: the full sweep
 * runs every three hours anyway, and re-asking about five thousand parcels
 * here would spend the budget on the ones already up to date.
 *
 * Same lock as everything else that asks Correos. A separate request from the
 * pull or the upload, too, because both are bounded by the same function
 * limit — doing the sweep inside the pull would give it whatever seconds the
 * pull left over, which on a thousand parcels is none.
 */
export async function sweepNewParcels(): Promise<SweepResult> {
  await requireUser();

  const lock = await acquireJobLock('reconcile', manualSweepLeaseSeconds());
  if (!lock.acquired) {
    return {
      ok: false,
      error: 'A check with Correos is already running, so this one did not start.',
    };
  }

  const lease: Lease = lock.lease;

  try {
    const outcome = await runJob('reconcile', async () => {
      const result = await reconcile({ onlyUnswept: true, budgetMs: manualSweepBudgetMs() });
      return { ...result, detail: { ...result.detail, manual: true } };
    });
    revalidatePath('/', 'layout');

    return outcome.ok
      ? { ok: true, detail: outcome.detail }
      : { ok: false, error: 'The check with Correos did not finish.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'The check did not finish.' };
  } finally {
    await releaseJobLock(lease).catch(() => {});
  }
}
