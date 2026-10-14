import { randomBytes, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';
import { getDb, retryableRead } from '@/db';
import { sessions, users } from '@/db/schema';
import { now, DAY } from '@/lib/clock';
import { perRequest } from '@/lib/per-request';

/**
 * Sessions live in the database so signing somebody out actually signs them
 * out. The cookie carries a random id; what is stored is its hash, so a leaked
 * database backup is not a set of live sessions.
 */

export const SESSION_COOKIE = 'rs_session';
const SESSION_DAYS = 30;

function hash(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

export async function createSession(userId: string): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await getDb().insert(sessions).values({
    id: hash(id),
    userId,
    createdAt: now(),
    expiresAt: new Date(now().getTime() + SESSION_DAYS * DAY),
  });
  return id;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Who is signed in. ONE QUERY PER REQUEST, however many times it is asked.
 *
 * Every panel page asks, and so does the layout around it, and so does every
 * server action — so this was the single most-run query in the app and the one
 * that most often hit a full pooler first. It is the query behind digest
 * 3880840699. `perRequest` is React's `cache()` where that exists and a
 * pass-through everywhere else, so a page view now costs one session lookup
 * instead of two or three.
 *
 * `retryableRead` because of what it is: a read, on the way in, where a
 * refused connection means "the pooler was full for a moment" rather than
 * "this person is not signed in". Failing it logs somebody out of a working
 * app. See withDbRetry in db/index.ts.
 */
const lookupSession = retryableRead('session lookup', async (token: string) => {
  const [row] = await getDb().select({
    id: users.id, email: users.email, name: users.name, disabledAt: users.disabledAt,
  })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hash(token)), gt(sessions.expiresAt, now())))
    .limit(1);

  if (!row || row.disabledAt) return null;
  return { id: row.id, email: row.email, name: row.name } satisfies SessionUser;
});

const cachedLookup = perRequest(lookupSession);

export async function currentUser(): Promise<SessionUser | null> {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return cachedLookup(raw);
}

export async function destroySession(): Promise<void> {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  if (raw) await getDb().delete(sessions).where(eq(sessions.id, hash(raw)));
  cookies().delete(SESSION_COOKIE);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

/** Expired rows are dead weight and a liability. The nightly job clears them. */
export async function purgeExpiredSessions(): Promise<number> {
  const gone = await getDb().delete(sessions).where(lt(sessions.expiresAt, now())).returning({ id: sessions.id });
  return gone.length;
}
