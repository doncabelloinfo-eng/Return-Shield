import type { NextResponse } from 'next/server';
import { loadDemoClock } from '@/lib/demo-clock';
import { requireScannerApi, readJson, scanError, scanJson } from '@/lib/scan/api';
import { finishBatch, previewBatch } from '@/lib/scan/batches';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const fetchCache = 'force-no-store';
/*
 * Above the release window (DB_IDLE_TIMEOUT + 1s past the last query). This one
 * reads the whole batch to count it, so it gets the same fifteen seconds rather
 * than the tightest number that would do. See tests/db-connections.test.ts.
 */
export const maxDuration = 15;

/**
 * "Complete this batch?" — the counts, without closing anything. Image 8.
 *
 * Counted from the rows rather than by a query per number, so the three figures
 * on the sheet and the list behind them cannot disagree. See `summarise` in
 * lib/scan/batches.ts.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const gate = await requireScannerApi();
  if (!gate.ok) return gate.response;

  const batchId = new URL(req.url).searchParams.get('batchId');
  if (!batchId) return scanError('Which batch?', 400);

  await loadDemoClock();
  const answer = await previewBatch(gate.user.id, batchId);
  if (!answer) return scanError('No such batch.', 404);

  return scanJson({ ok: true, ...answer });
}

/**
 * "Finish batch". Image 9.
 *
 * The phone only calls this once its queue is empty, so the counts it shows are
 * the counts the server has. Idempotent, because the button is on a phone and a
 * phone double-taps: a batch already finished keeps the time it was finished
 * and answers with the same summary.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const gate = await requireScannerApi();
  if (!gate.ok) return gate.response;

  const body = await readJson<{ batchId?: string }>(req);
  if (!body?.batchId) return scanError('Which batch?', 400);

  await loadDemoClock();
  const answer = await finishBatch(gate.user.id, body.batchId);
  if (!answer) return scanError('No such batch.', 404);

  return scanJson({ ok: true, ...answer });
}
