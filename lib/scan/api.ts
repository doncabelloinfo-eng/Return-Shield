import { NextResponse } from 'next/server';
import { currentUser, type SessionUser } from '@/lib/auth/session';

/**
 * The guard the Scanner's own API routes use, and the shape of their answers.
 *
 * NOT `requireScanner()`. That one redirects, which is right for a page and
 * wrong here: these routes answer a `fetch` from the phone, and a 302 to
 * /scan/login arrives as an HTML body the phone then fails to parse as JSON —
 * so a signed-out phone would show "could not read the answer" instead of
 * "sign in again". A status code is the honest answer, and the phone acts on it.
 *
 * AN OPERATOR IS REFUSED TOO. Not because an office account doing it would be
 * dangerous, but because "every scanner route refuses an operator session" is
 * only worth testing if it holds for all of them, and an account with no batch
 * and no worker name has nothing to say here anyway.
 */

export type ScannerGate =
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse };

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function scanError(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export function scanJson(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function requireScannerApi(): Promise<ScannerGate> {
  if (!process.env.DATABASE_URL) {
    return { ok: false, response: scanError('No database is configured.', 503) };
  }

  const user = await currentUser();
  // 401 and not a redirect: the phone turns this into "sign in again" and goes
  // to /scan/login itself, which keeps the installed app inside its own scope.
  if (!user) return { ok: false, response: scanError('signed-out', 401) };
  if (user.role !== 'scanner') {
    return { ok: false, response: scanError('This is for Scanner accounts.', 403) };
  }

  return { ok: true, user };
}

/** A JSON body, or null for anything that is not one. Never throws. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as T) : null;
  } catch {
    return null;
  }
}
