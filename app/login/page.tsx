import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, currentUser, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * One business, a handful of people, no public signup. Accounts are made with
 * `npm run db:seed` or by hand.
 *
 * The failure message never says whether it was the email or the password that
 * was wrong — telling somebody an address is registered is telling them which
 * addresses to try passwords against.
 */
export default async function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  if (await currentUser()) redirect('/today');

  async function signIn(form: FormData) {
    'use server';

    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    if (!email || !password) redirect('/login?error=1');

    const [user] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);

    // Verify even when there is no such user, so a missing account and a wrong
    // password take the same amount of time to fail.
    const dummy = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(password, user?.passwordHash ?? dummy);

    if (!user || !ok || user.disabledAt) redirect('/login?error=1');

    const token = await createSession(user.id);
    cookies().set(SESSION_COOKIE, token, sessionCookieOptions());
    redirect('/today');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-[9px]">
          <span className="h-[10px] w-[10px] rounded-[2px] bg-accent" />
          <span className="font-display text-[17px] font-bold tracking-[.02em] text-ink">Return Shield</span>
        </div>

        <form action={signIn} className="rounded-md border border-line bg-surface p-6 shadow-focus">
          <h1 className="m-0 font-display text-[18px] font-bold text-ink">Sign in</h1>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">
            Every parcel sitting in a post office, and what to do about it today.
          </p>

          {searchParams.error && (
            <div className="mt-4 rounded border border-crit bg-critsoft px-3 py-[10px] text-[12.5px] font-medium text-crit">
              That email and password did not match.
            </div>
          )}

          <label className="mt-4 block text-[12px] font-semibold text-ink" htmlFor="email">Email</label>
          <input
            id="email" name="email" type="email" required autoComplete="username" autoFocus
            className="mt-1 w-full rounded border border-line bg-surface2 px-3 py-[10px] text-[13px] text-ink"
          />

          <label className="mt-3 block text-[12px] font-semibold text-ink" htmlFor="password">Password</label>
          <input
            id="password" name="password" type="password" required autoComplete="current-password"
            className="mt-1 w-full rounded border border-line bg-surface2 px-3 py-[10px] text-[13px] text-ink"
          />

          <button type="submit" className="mt-5 w-full rounded bg-navy py-[11px] text-[13px] font-bold text-white">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
