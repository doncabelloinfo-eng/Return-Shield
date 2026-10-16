import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { asUserRole, type UserRole } from '@/lib/auth/roles';

/**
 * Deciding whether somebody may sign in, in one place for both forms.
 *
 * There are two sign-in pages now — the office at /login?as=panel and the
 * warehouse at /scan/login — and they differ only in which kind of account they
 * accept and what they say when the other kind turns up. Written twice, the
 * second copy is where somebody eventually forgets the disabled check.
 *
 * THE ORDER OF THE CHECKS IS THE SECURITY PROPERTY.
 *
 * The password is verified first, and verified even when there is no such user,
 * so a missing account and a wrong password take the same time and give the
 * same answer. Only after a CORRECT password does the answer become specific —
 * "this account is turned off", "this is a Scanner account" — because at that
 * point the person already knows the account exists, and a useful message costs
 * nothing. Reversing those two would turn this into a way to ask which email
 * addresses are registered.
 */

export type SignInOutcome =
  /** Correct, and the right kind of account for this form. */
  | { ok: true; userId: string; role: UserRole }
  /** No such account, or the wrong password. Never says which. */
  | { ok: false; reason: 'no-match' }
  /** Correct password, but the operator has turned this account off. */
  | { ok: false; reason: 'disabled' }
  /** Correct password, wrong door. `has` is the account's actual kind. */
  | { ok: false; reason: 'wrong-form'; has: UserRole };

/**
 * A hash that nothing can match, with the production parameters, so a sign-in
 * attempt for an address with no account costs the same scrypt work as one for
 * an address with an account.
 */
const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';

export async function attemptSignIn(
  rawEmail: string,
  password: string,
  wants: UserRole,
): Promise<SignInOutcome> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) return { ok: false, reason: 'no-match' };

  const [user] = await getDb().select().from(users).where(eq(users.email, email)).limit(1);
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY);
  if (!user || !ok) return { ok: false, reason: 'no-match' };

  if (user.disabledAt) return { ok: false, reason: 'disabled' };

  const role = asUserRole(user.role);
  if (role !== wants) return { ok: false, reason: 'wrong-form', has: role };

  return { ok: true, userId: user.id, role };
}
