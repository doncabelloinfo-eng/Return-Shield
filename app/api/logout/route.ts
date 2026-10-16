import { NextResponse } from 'next/server';
import { currentUser, destroySession } from '@/lib/auth/session';
import { LOGIN_FOR } from '@/lib/auth/roles';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Sign out, and land where this account signs in.
 *
 * The role is read BEFORE the session goes, because afterwards there is nobody
 * to ask. A warehouse phone sent to /login would be shown the office form and
 * the two-way choice; sending it to /scan/login keeps it inside the installed
 * app's own scope, which is the one thing the Scanner's URLs have to get right.
 *
 * A signed-out request gets /login, which is the right answer for a stale tab.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const user = await currentUser();
  const back = user ? LOGIN_FOR[user.role] : '/login';
  await destroySession();
  return NextResponse.redirect(new URL(back, req.url), { status: 303 });
}
