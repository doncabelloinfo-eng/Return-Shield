import { redirect } from 'next/navigation';
import { currentUser, type SessionUser } from './session';
import { HOME_FOR } from './roles';

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
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'operator') redirect(HOME_FOR[user.role]);
  return user;
}

/**
 * The other side: `/scan` and the APIs the phone calls.
 *
 * An operator who opens `/scan` is sent to the panel. They are not refused
 * because they did something wrong — an office account simply has no batch, no
 * worker name to put on a scan, and no business leaving "Left the warehouse"
 * stamps on parcels from a desk.
 */
export async function requireScanner(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/scan/login');
  if (user.role !== 'scanner') redirect(HOME_FOR[user.role]);
  return user;
}
