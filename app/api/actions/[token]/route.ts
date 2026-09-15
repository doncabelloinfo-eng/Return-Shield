import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { shipmentActions } from '@/db/schema';
import { resolveToken } from '@/lib/customer-page';
import { applyCustomerAction, isCustomerAction } from '@/lib/escalation/outcomes';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { now } from '@/lib/clock';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * The customer tapped something. This is the only endpoint in the system that
 * accepts a write from somebody who is not signed in, so it is the only one
 * that has to assume every request is hostile.
 *
 * The token is verified by signature first (cheap, no database), then resolved
 * against the shipment, then rate-limited per IP. A tap only ever chooses one
 * of four fixed actions — there is no free text and nothing to inject.
 */
export async function POST(
  req: Request,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const ip = clientIp(req);

  const limit = await rateLimit(ip, 30);
  if (!limit.ok) {
    return NextResponse.json(
      { message: 'Demasiados intentos. Espera unos minutos.' },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => null) as { action?: unknown } | null;
  const action = typeof body?.action === 'string' ? body.action : '';

  if (!isCustomerAction(action)) {
    return NextResponse.json({ message: 'Acción no válida.' }, { status: 400 });
  }

  const resolved = await resolveToken(params.token);
  if (!resolved.ok) {
    const message = resolved.why === 'finished'
      ? 'Este pedido ya está entregado.'
      : 'Este enlace ya no está disponible.';
    return NextResponse.json({ message }, { status: 410 });
  }

  await getDb().insert(shipmentActions).values({
    shipmentId: resolved.view.shipmentId,
    notificationId: resolved.view.notificationId,
    token: params.token,
    action,
    payload: {},
    createdAt: now(),
    ip,
    userAgent: req.headers.get('user-agent'),
  });

  await applyCustomerAction(resolved.view.shipmentId, action);

  return NextResponse.json({ status: 'ok' });
}
