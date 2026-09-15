import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth/session';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(req: Request): Promise<NextResponse> {
  await destroySession();
  return NextResponse.redirect(new URL('/login', req.url), { status: 303 });
}
