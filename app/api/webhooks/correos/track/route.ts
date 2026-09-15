import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { correosPushInbox } from '@/db/schema';
import { now } from '@/lib/clock';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Correos' ShipmentTrack&TracePush calls this. We build it; they call it.
 *
 * Two rules, both learned the expensive way:
 *
 *   1. Return 200 immediately. There is no guaranteed retry — an event we are
 *      too slow to acknowledge, or that we 500 on, is simply gone. So the raw
 *      body goes into a staging table and we acknowledge; the normaliser runs
 *      afterwards, in the worker. A normaliser bug then costs a replay rather
 *      than a day of missing tracking.
 *
 *   2. Authenticate before anything else. clientID / clientSecret in the
 *      headers, and the source IP against the fixed address Correos gives us.
 */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(req: Request): { ok: true } | { ok: false; why: string } {
  const expectedId = process.env.CORREOS_PUSH_CLIENT_ID;
  const expectedSecret = process.env.CORREOS_PUSH_CLIENT_SECRET;

  if (!expectedId || !expectedSecret) {
    // Refusing everything is the only safe thing an unconfigured receiver can
    // do. An open endpoint that writes to the shipment table is worse than a
    // closed one that loses events until somebody notices.
    return { ok: false, why: 'receiver is not configured' };
  }

  const id = req.headers.get('clientID') ?? req.headers.get('clientid') ?? '';
  const secret = req.headers.get('clientSecret') ?? req.headers.get('clientsecret') ?? '';

  if (!timingSafeEqual(id, expectedId) || !timingSafeEqual(secret, expectedSecret)) {
    return { ok: false, why: 'bad credentials' };
  }

  const allowed = (process.env.CORREOS_PUSH_ALLOWED_IPS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (allowed.length) {
    const ip = sourceIp(req);
    if (!ip || !allowed.includes(ip)) return { ok: false, why: `unexpected source ip ${ip ?? 'unknown'}` };
  }

  return { ok: true };
}

function sourceIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = authorised(req);
  if (!auth.ok) {
    console.warn('[correos-push] rejected:', auth.why);
    return NextResponse.json({ status: 'rejected' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    // Even a body we cannot parse is kept. If Correos is sending something
    // unexpected, the payload is the evidence — and 200 keeps them sending.
    payload = { unparseable: true, receivedAt: now().toISOString() };
  }

  try {
    await getDb().insert(correosPushInbox).values({
      payload: payload as object,
      receivedAt: now(),
      sourceIp: sourceIp(req),
    });
  } catch (err) {
    // The database is down. Log loudly and still return 200: a 500 loses the
    // event for good, whereas the log can be replayed by hand.
    console.error('[correos-push] COULD NOT STAGE PAYLOAD:', err);
    console.error('[correos-push] payload was:', JSON.stringify(payload));
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

/** Correos check the endpoint is alive before they start sending. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'ok', service: 'return-shield-correos-push' });
}
