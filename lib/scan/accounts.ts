import { and, asc, eq, sql as raw } from 'drizzle-orm';
import { getDb, retryableRead, rowsOf } from '@/db';
import { users } from '@/db/schema';
import { now } from '@/lib/clock';
import { hashPassword } from '@/lib/auth/password';
import { endSessionsFor } from '@/lib/auth/session';

/**
 * The warehouse workers, and the four things the operator can do to one.
 *
 * There is still no public signup and no invitation email. The operator types a
 * password, reads it out to the worker, and can set a new one — which is the
 * right shape for a handful of people who work in the same building, and avoids
 * a password-reset flow nobody would use twice a year.
 *
 * EVERY WRITE IS FENCED TO `role = 'scanner'`. Not because the Settings screen
 * would ever offer an operator here, but because these take an id out of a form
 * and anyone who can reach a server action can send any id they like. Without
 * the fence, "set a new password" is a way to take over the office account.
 */

export interface ScannerAccount {
  id: string;
  name: string;
  email: string;
  active: boolean;
  /** When they last scanned anything, or null if they never have. */
  lastScanAt: Date | null;
}

interface AccountRow {
  id: string;
  name: string;
  email: string;
  disabled_at: string | null;
  last_scan_at: string | null;
}

export const scannerAccounts = retryableRead('scanner accounts', async (): Promise<ScannerAccount[]> => {
  /*
   * The last scan comes from a LATERAL with a LIMIT rather than a
   * `max(scanned_at)` GROUP BY: `scans_user_time_idx` turns each worker's
   * newest scan into one index lookup, where the aggregate reads every scan
   * they have ever made — ninety days of a warehouse, to draw one date.
   */
  const result = await getDb().execute(raw`
    SELECT u.id, u.name, u.email, u.disabled_at, last.scanned_at AS last_scan_at
      FROM users u
      LEFT JOIN LATERAL (
        SELECT s.scanned_at FROM scans s
         WHERE s.user_id = u.id
         ORDER BY s.scanned_at DESC
         LIMIT 1
      ) last ON true
     WHERE u.role = 'scanner'
     ORDER BY u.name
  `);

  return rowsOf<AccountRow>(result).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    active: r.disabled_at === null,
    lastScanAt: r.last_scan_at ? new Date(r.last_scan_at) : null,
  }));
});

export interface AddScannerInput {
  name: string;
  email: string;
  password: string;
}

export type AddScannerResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** The shortest password this will accept. Typed by hand, read out loud. */
export const MIN_PASSWORD_LENGTH = 8;

export async function addScanner(input: AddScannerInput): Promise<AddScannerResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  if (!name) return { ok: false, error: 'Give the worker a name.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'That email does not look right.' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  // One index on email, shared by both kinds of account, so this catches an
  // address already used by the office as well as by another worker. Checked
  // here for the message and enforced by the unique index either way.
  const [taken] = await getDb().select({ id: users.id, role: users.role })
    .from(users).where(eq(users.email, email)).limit(1);
  if (taken) {
    return {
      ok: false,
      error: taken.role === 'scanner'
        ? 'A worker with that email already exists.'
        : 'That email is a Return Shield account.',
    };
  }

  const [row] = await getDb().insert(users).values({
    email,
    name,
    passwordHash: await hashPassword(password),
    role: 'scanner',
    createdAt: now(),
  }).returning({ id: users.id });

  return { ok: true, id: row.id };
}

export type AccountChange = { ok: true } | { ok: false; error: string };

/**
 * Turn a worker off or on.
 *
 * Disabling ends their sessions at once rather than at the next page load. The
 * flag alone would already refuse the next request — `lookupSession` checks it
 * — and the rows go too, because the case this is for is a phone left on a bus.
 */
export async function setScannerActive(id: string, active: boolean): Promise<AccountChange> {
  const changed = await getDb().update(users)
    .set({ disabledAt: active ? null : now() })
    .where(and(eq(users.id, id), eq(users.role, 'scanner')))
    .returning({ id: users.id });

  if (!changed.length) return { ok: false, error: 'No such worker.' };
  if (!active) await endSessionsFor(id);
  return { ok: true };
}

export async function setScannerPassword(id: string, password: string): Promise<AccountChange> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const changed = await getDb().update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(and(eq(users.id, id), eq(users.role, 'scanner')))
    .returning({ id: users.id });

  if (!changed.length) return { ok: false, error: 'No such worker.' };
  /*
   * A new password ends the old sessions.
   *
   * The operator sets one for a reason — a worker left, a phone went missing,
   * somebody read the password out in the wrong room — and a new password that
   * leaves the old phone signed in does not answer any of those.
   */
  await endSessionsFor(id);
  return { ok: true };
}

/** For the empty state: has anybody set up a worker yet? */
export const anyScanners = retryableRead('any scanners', async (): Promise<boolean> => {
  const [row] = await getDb().select({ id: users.id }).from(users)
    .where(eq(users.role, 'scanner')).orderBy(asc(users.createdAt)).limit(1);
  return Boolean(row);
});
