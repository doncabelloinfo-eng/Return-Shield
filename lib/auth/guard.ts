import { redirect } from 'next/navigation';
import { currentUser, type SessionUser } from './session';

/**
 * Every panel page and every mutating action goes through here. There is no
 * public signup: accounts are created with `npm run db:seed` or by hand, which
 * is the right shape for one business with a handful of people.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
