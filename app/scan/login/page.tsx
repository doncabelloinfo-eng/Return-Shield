import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, currentUser, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { asUserRole, HOME_FOR, WRONG_FORM_FOR } from '@/lib/auth/roles';
import { PasswordField } from '@/components/scan/PasswordField';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The warehouse phone signs in here. Image 1.
 *
 * Inside /scan on purpose: it is within the installed app's scope, so a phone
 * that opens Scanner from its home screen and turns out to be signed out stays
 * in the app rather than opening a browser tab.
 *
 * It accepts scanner accounts only. An office account that gets here is told
 * which button to press — after its password has been checked, so the message
 * gives nothing away to somebody guessing addresses.
 */
export default async function ScannerLoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const signedIn = await currentUser();
  if (signedIn) redirect(HOME_FOR[signedIn.role]);

  async function signIn(form: FormData) {
    'use server';

    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    // The tick is checked by default in the design, and an unticked checkbox
    // sends nothing at all — so absence means "not this phone".
    const remember = form.get('keep') === 'on';

    if (!email || !password) redirect('/scan/login?error=1');

    const [user] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);

    // Verify even when there is no such user, so a missing account and a wrong
    // password take the same amount of time to fail.
    const dummy = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(password, user?.passwordHash ?? dummy);

    if (!user || !ok) redirect('/scan/login?error=1');
    // A worker the operator has turned off. Said plainly, because it is the one
    // failure a correct password cannot fix and the worker needs to know who to
    // ask rather than trying again.
    if (user.disabledAt) redirect('/scan/login?error=off');
    if (asUserRole(user.role) !== 'scanner') redirect('/scan/login?error=role');

    const token = await createSession(user.id);
    cookies().set(SESSION_COOKIE, token, sessionCookieOptions(remember));
    redirect('/scan');
  }

  const error = searchParams.error;

  return (
    <main className="flex min-h-[100dvh] flex-col bg-navy">
      <div className="flex flex-col gap-[14px] px-5 pb-8 pt-[52px] text-white">
        <div className="flex items-center gap-[9px]">
          <span className="h-[10px] w-[10px] rounded-[2px] bg-accent" />
          <span className="text-[13px] font-semibold tracking-[.02em] text-navmuted">Return Shield</span>
        </div>
        <h1 className="m-0 font-display text-[44px] font-bold leading-none tracking-[-.02em]">Scanner</h1>
        <p className="m-0 max-w-[300px] text-[16px] leading-[1.5] text-navmuted">
          Scan the Correos label on every parcel going out or coming back.
        </p>
        {/* The barcode stripe from image 1. Decoration, so it is hidden from
            anything that reads the page aloud. */}
        <div
          aria-hidden="true"
          className="h-[26px] w-[196px] opacity-55"
          style={{
            background:
              'repeating-linear-gradient(90deg, var(--accent) 0 3px, transparent 3px 5px, '
              + 'var(--accent) 5px 6px, transparent 6px 9px, var(--accent) 9px 13px, '
              + 'transparent 13px 14px, var(--accent) 14px 15px, transparent 15px 19px)',
          }}
        />
      </div>

      <form
        action={signIn}
        className="flex flex-1 flex-col gap-[18px] rounded-t-[24px] bg-ground px-5 pb-8 pt-7"
      >
        <h2 className="m-0 text-[22px] font-semibold tracking-[-.01em] text-ink">Sign in</h2>

        {error && (
          <div
            role="alert"
            className="rounded-[10px] border border-crit bg-critsoft px-[14px] py-[11px] text-[13.5px] font-medium leading-[1.45] text-crit"
          >
            {error === 'role'
              ? WRONG_FORM_FOR.operator
              : error === 'off'
                ? 'This account has been turned off. Ask the person who set up your account.'
                : 'That email and password did not match.'}
          </div>
        )}

        <div className="flex flex-col gap-[6px]">
          <label htmlFor="scan-email" className="text-[13px] font-semibold text-ink">Email</label>
          <input
            id="scan-email"
            name="email"
            type="email"
            required
            autoComplete="username"
            placeholder="name@company.com"
            className="h-[52px] w-full rounded-[10px] border border-line bg-surface px-[14px] text-[16px] text-ink"
          />
        </div>

        <PasswordField />

        <label
          htmlFor="scan-keep"
          className="flex min-h-[44px] items-center gap-[10px] text-[14px] text-ink"
        >
          <input
            id="scan-keep"
            name="keep"
            type="checkbox"
            defaultChecked
            className="h-5 w-5 accent-navy"
          />
          Keep me signed in on this phone
        </label>

        <button
          type="submit"
          className="flex h-[56px] items-center justify-center rounded-[10px] bg-navy text-[17px] font-semibold text-white"
        >
          Sign in
        </button>

        <p className="m-0 text-[13px] leading-[1.5] text-muted">
          Use the Scanner login you were given. Forgot your password? Ask the person who set up
          your account.
        </p>

        <Link href="/login" className="text-[13px] font-semibold text-muted hover:text-crit">
          Not a Scanner account? Sign in to Return Shield
        </Link>
      </form>
    </main>
  );
}
