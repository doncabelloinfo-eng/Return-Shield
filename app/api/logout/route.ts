import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth/session';

export async function POST(req: Request): Promise<NextResponse> {
  await destroySession();
  return NextResponse.redirect(new URL('/login', req.url), { status: 303 });
}
