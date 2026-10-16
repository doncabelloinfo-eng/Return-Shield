import type { NextResponse } from 'next/server';
import { loadDemoClock } from '@/lib/demo-clock';
import { requireScannerApi, readJson, scanError, scanJson } from '@/lib/scan/api';
import { addScan, removeScan } from '@/lib/scan/batches';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const fetchCache = 'force-no-store';
/*
 * Above the release window (DB_IDLE_TIMEOUT + 1s past the last query), with
 * room for the match lookup and the insert. See tests/db-connections.test.ts.
 */
export const maxDuration = 15;

/**
 * One read of one label.
 *
 * THE PHONE HAS ALREADY BEEPED by the time this is called. Every read is
 * written to IndexedDB first and the beep follows that, because "beep means it
 * is saved" has to stay true in a warehouse with no signal — so this endpoint
 * is the second half of a save that has already happened, and it will be called
 * again, and again, until it answers. It is built for that: `readId` is the id
 * the phone gave the read, and sending the same one twice changes nothing at
 * all. See lib/scan/batches.ts.
 *
 * WHAT IT ANSWERS WITH IS DELIBERATELY THIN: the code, what it matched, the
 * postcode off the label and the time. No customer name, no phone, no address,
 * no value. The Scanner is not given them, so it cannot leak them, and a
 * warehouse phone is the account most likely to be lost.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const gate = await requireScannerApi();
  if (!gate.ok) return gate.response;

  const body = await readJson<{
    batchId?: string; readId?: string; code?: string; source?: string; at?: string;
  }>(req);

  if (!body?.batchId || !body.readId || !body.code) return scanError('Not enough to store.', 400);
  const source = body.source === 'typed' ? 'typed' : 'barcode';

  await loadDemoClock();
  const answer = await addScan(gate.user.id, {
    batchId: body.batchId,
    readId: body.readId,
    code: body.code,
    source,
    at: body.at,
  });

  // 422 rather than 400 for an unreadable code: the request was fine, the thing
  // on the label was not, and the phone shows that differently.
  if (!answer.ok) return scanError(answer.error, answer.error === 'No such batch.' ? 404 : 422);

  return scanJson({
    ok: true,
    item: answer.item,
    duplicate: answer.duplicate,
    counted: answer.counted,
  });
}

/**
 * The × on a row. No dialog, by the operator's instruction — which is fine
 * because undoing it means scanning the parcel again.
 */
export async function DELETE(req: Request): Promise<NextResponse> {
  const gate = await requireScannerApi();
  if (!gate.ok) return gate.response;

  const body = await readJson<{ id?: string }>(req);
  if (!body?.id) return scanError('Which scan?', 400);

  await loadDemoClock();
  const gone = await removeScan(gate.user.id, body.id);
  // Already gone is the same outcome as just gone, and a phone retries.
  return scanJson({ ok: true, removed: gone });
}
