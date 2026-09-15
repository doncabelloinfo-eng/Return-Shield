import { NextResponse } from 'next/server';
import { verifyShopifyHmac, storeEnv } from '@/lib/carriers/shopify/verify';
import { ingestShopifyOrder, type ShopifyOrderPayload } from '@/lib/carriers/shopify/ingest';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Shopify `orders/fulfilled`, one route per store.
 *
 * The signature is checked on the raw bytes before the body is parsed —
 * parsing first would mean an attacker's JSON gets parsed, and re-serialising
 * the body to verify it would fail on every genuine webhook from a store whose
 * payloads are formatted differently.
 */
export async function POST(
  req: Request,
  { params }: { params: { store: string } },
): Promise<NextResponse> {
  const secret = storeEnv(params.store, 'WEBHOOK_SECRET');
  if (!secret) {
    console.warn(`[shopify] no webhook secret configured for store "${params.store}"`);
    return NextResponse.json({ error: 'unknown store' }, { status: 401 });
  }

  const raw = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get('x-shopify-hmac-sha256');

  if (!verifyShopifyHmac(raw, signature, secret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(raw.toString('utf8')) as ShopifyOrderPayload;
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  try {
    const result = await ingestShopifyOrder(params.store, payload);
    return NextResponse.json({ status: result.status, shipments: result.shipmentIds.length });
  } catch (err) {
    // A 500 makes Shopify retry, which is what we want for a transient fault.
    console.error('[shopify] ingest failed:', err);
    return NextResponse.json({ error: 'ingest failed' }, { status: 500 });
  }
}
