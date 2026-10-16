import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, currentUser, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { asUserRole, HOME_FOR, WRONG_FORM_FOR } from '@/lib/auth/roles';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * One business, a handful of people, no public signup. Accounts are made with
 * `npm run db:seed` or by hand.
 *
 * TWO KINDS OF ACCOUNT NOW SIGN IN HERE, so this page opens with the choice
 * rather than with a form: the office, and a warehouse phone. The phone's own
 * sign-in lives at /scan/login, inside the Scanner's installed scope, so an
 * installed app never drops into a browser tab to sign in.
 *
 * `?as=panel` is the office form, unchanged — the same fields, the same
 * wording, the same failure. A link rather than client-side state because this
 * page has no JavaScript of its own and should not grow any for one choice.
 *
 * The failure message never says whether it was the email or the password that
 * was wrong — telling somebody an address is registered is telling them which
 * addresses to try passwords against. The one message that does name the
 * account is only shown AFTER the right password: at that point there is
 * nothing left to give away, and "wrong form" is the only useful thing to say.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; as?: string };
}) {
  const signedIn = await currentUser();
  if (signedIn) redirect(HOME_FOR[signedIn.role]);

  if (searchParams.as !== 'panel') return <Choice />;

  async function signIn(form: FormData) {
    'use server';

    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    if (!email || !password) redirect('/login?as=panel&error=1');

    const [user] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);

    // Verify even when there is no such user, so a missing account and a wrong
    // password take the same amount of time to fail.
    const dummy = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(password, user?.passwordHash ?? dummy);

    if (!user || !ok || user.disabledAt) redirect('/login?as=panel&error=1');

    // The right password for a warehouse account. Say so, and say which button
    // to press: this form cannot sign a scanner in, because `requireUser`
    // would refuse it on the next page anyway.
    if (asUserRole(user.role) !== 'operator') redirect('/login?as=panel&error=role');

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

          {searchParams.error === 'role' ? (
            <div className="mt-4 rounded border border-crit bg-critsoft px-3 py-[10px] text-[12.5px] font-medium text-crit">
              {WRONG_FORM_FOR.scanner}
            </div>
          ) : searchParams.error ? (
            <div className="mt-4 rounded border border-crit bg-critsoft px-3 py-[10px] text-[12.5px] font-medium text-crit">
              That email and password did not match.
            </div>
          ) : null}

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

          <Link
            href="/login"
            className="mt-4 block text-center text-[12px] font-semibold text-muted hover:text-crit"
          >
            Not this? Choose again
          </Link>
        </form>
      </div>
    </main>
  );
}

/** The two doors. Nothing else on the page, so neither can be missed. */
function Choice() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-[9px]">
          <span className="h-[10px] w-[10px] rounded-[2px] bg-accent" />
          <span className="font-display text-[17px] font-bold tracking-[.02em] text-ink">Return Shield</span>
        </div>

        <div className="rounded-md border border-line bg-surface p-6 shadow-focus">
          <h1 className="m-0 font-display text-[18px] font-bold text-ink">Sign in</h1>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">
            Two kinds of account. Pick the one you were given.
          </p>

          <Link
            href="/login?as=panel"
            className="mt-5 flex items-center gap-[12px] rounded border border-line bg-surface2 px-[14px] py-[12px] hover:bg-hover"
          >
            <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded bg-navy text-[13px] font-bold text-white">
              RS
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-bold text-ink">Login as Return Shield</span>
              <span className="block text-[11.5px] leading-[1.45] text-muted">
                The office: parcels, calls, uploads and settings
              </span>
            </span>
          </Link>

          <Link
            href="/scan/login"
            className="mt-[10px] flex items-center gap-[12px] rounded border border-line bg-surface2 px-[14px] py-[12px] hover:bg-hover"
          >
            <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded bg-accent text-[13px] font-bold text-navy">
              SC
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-bold text-ink">Login as Scanner</span>
              <span className="block text-[11.5px] leading-[1.45] text-muted">
                The warehouse phone: scan parcels going out and coming back
              </span>
            </span>
          </Link>
        </div>
      </div>
    </main>
  );
}
