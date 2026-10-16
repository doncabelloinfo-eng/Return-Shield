import type { NextResponse } from 'next/server';
import { loadDemoClock } from '@/lib/demo-clock';
import { requireScannerApi, readJson, scanError, scanJson } from '@/lib/scan/api';
import { currentBatch, openBatch, openBatches } from '@/lib/scan/batches';
import { isScanDirection } from '@/lib/scan/model';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/*
 * Same reason as every other route here: a GET with no cache option, inside a
 * route handler, goes into Next's Data Cache with a one-year revalidate. A
 * cached batch is a batch that never grows. See
 * lib/carriers/correos/trackpub.ts for the day that cost.
 */
export const fetchCache = 'force-no-store';
/*
 * Above the release window, which holds an invocation for DB_IDLE_TIMEOUT + 1s
 * past its last query. Two short queries, so fifteen seconds is all slack.
 * See tests/db-connections.test.ts.
 */
export const maxDuration = 15;

/**
 * The open batch, resumed.
 *
 * What the phone asks for when it is opened: a worker who closed the app with
 * a pile half done gets the pile back, from the server, because the phone's own
 * copy may be a different phone. It also returns every open batch, so the
 * "switch direction" screen can say "complete the outgoing batch first" without
 * a second request.
 *
 * GET DOES NOT OPEN ONE. Opening is a write, and a phone that polls — or a
 * browser that prefetches — must not leave empty batches behind.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const gate = await requireScannerApi();
  if (!gate.ok) return gate.response;

  const direction = new URL(req.url).searchParams.get('direction');
  if (!isScanDirection(direction)) return scanError('Which direction?', 400);

  await loadDemoClock();
  const [batch, open] = await Promise.all([
    currentBatch(gate.user.id, direction),
    openBatches(gate.user.id),
  ]);

  return scanJson({ ok: true, batch, open, worker: gate.user.name });
}

/** Start scanning: the open batch for this direction, or a new one. */
export async function POST(req: Request): Promise<NextResponse> {
  const gate = await requireScannerApi();
  if (!gate.ok) return gate.response;

  const body = await readJson<{ direction?: string }>(req);
  if (!isScanDirection(body?.direction)) return scanError('Which direction?', 400);

  await loadDemoClock();
  const batch = await openBatch(gate.user.id, body.direction);
  const open = await openBatches(gate.user.id);

  return scanJson({ ok: true, batch, open, worker: gate.user.name });
}
