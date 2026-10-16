import { redirect } from 'next/navigation';
import { currentUser, type SessionUser } from './session';
import { asUserRole, HOME_FOR } from './roles';

/**
 * Every panel page and every mutating action goes through here. There is no
 * public signup: accounts are created with `npm run db:seed` or by hand, which
 * is the right shape for one business with a handful of people.
 *
 * IT IS OPERATOR-ONLY, AND THAT IS THE DEFAULT ON PURPOSE. A warehouse phone
 * signs in as a `scanner`, and `requireUser` is the one thing standing between
 * that phone and the whole panel: every page under app/(panel) is behind this
 * via the layout, and every server action calls it by hand. Making the EXISTING
 * guard the strict one means a page or an action written next year is refused
 * to a scanner without anybody remembering this rule — the mistake you cannot
 * make is better than the rule you have to remember. tests/roles.test.ts walks
 * every page, action and route and proves it.
 *
 * A scanner is sent to `/scan` rather than shown an error: it is not a failure,
 * it is a phone that followed a link meant for the office.
 *
 * THROUGH `asUserRole`, EVEN THOUGH `currentUser` ALREADY NORMALISES. This is
 * the last line, so it does not get to assume the line before it ran: comparing
 * a raw value sent anything unrecognised to `HOME_FOR[<that value>]`, which is
 * `undefined` — a redirect to nowhere rather than a refusal. Nothing in
 * production can produce that today (the CHECK constraint allows two values and
 * the session lookup normalises), and a guard that is only correct because of
 * what happens upstream is a guard that breaks the day somebody calls it with a
 * session they built themselves.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');

  const role = asUserRole(user.role);
  if (role !== 'operator') redirect(HOME_FOR[role]);
  // The normalised role, so whatever is handed on is the one that was checked.
  return { ...user, role };
}

/**
 * The other side: `/scan` and the APIs the phone calls.
 *
 * An operator who opens `/scan` is sent to the panel. They are not refused
 * because they did something wrong — an office account simply has no batch, no
 * worker name to put on a scan, and no business leaving "Left the warehouse"
 * stamps on parcels from a desk.
 *
 * Normalised the same way, and for the same reason. An unrecognised role is an
 * operator (lib/auth/roles.ts), so it is sent to the panel and refused here —
 * which is the safe direction: the failure that locks the office out of its own
 * panel is visible in a second, the one that hands a warehouse phone the panel
 * is not.
 */
export async function requireScanner(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/scan/login');

  const role = asUserRole(user.role);
  if (role !== 'scanner') redirect(HOME_FOR[role]);
  return { ...user, role };
}
