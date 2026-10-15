import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { connectionShape } from './connection';
import { envNumber } from '@/lib/env';

/**
 * The database client, built on first use and never at import time.
 *
 * This is the difference between a build that needs a live production database
 * and one that does not. Next.js evaluates every route module during
 * "Collecting page data"; anything constructed at module scope runs then. A
 * client built at module scope means every build, every preview deployment and
 * every CI run has to be able to reach the real database — and a missing
 * environment variable fails the whole build rather than one request.
 *
 * So: nothing is read from the environment and no socket is opened until
 * something actually asks a question of the database.
 */

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Next.js hot-reloads modules in development, so the client is parked on
 * globalThis — otherwise every save leaks a pool until Postgres refuses new
 * connections.
 */
const globalForDb = globalThis as unknown as {
  __rsClient?: postgres.Sql;
  __rsDb?: Db;
};

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Return Shield keeps every parcel, event and '
      + 'deadline in Postgres, so nothing that touches data can work without it. '
      + 'Set it in the Vercel project settings (or in .env locally) and retry.',
    );
  }
  return url;
}

/** The raw postgres.js client. Prefer `getDb()` unless you need raw SQL. */
export function getSql(): postgres.Sql {
  // Before the cached-client return, not after it: the release window is
  // measured from the last use of the pool, and all but the very first use
  // takes this early exit.
  armIdleRelease();
  if (globalForDb.__rsClient) return globalForDb.__rsClient;

  const url = connectionString();
  const shape = connectionShape(url);

  const client = postgres(url, {
    /*
     * ONE CONNECTION PER INSTANCE ON VERCEL, AND THIS NUMBER IS LOAD-BEARING.
     *
     * The app is on Supabase's SESSION pooler, port 5432, because transaction
     * mode crossed query parameters between concurrent queries — see the note
     * at the top of db/connection.ts. Session mode gives each client its own
     * backend for the life of the connection, so the ceiling is the project's
     * pool size: 15 on this Nano instance.
     *
     * This used to be 3, and 109 errors in a week came of it. Every one was
     * the same:
     *
     *   (EMAXCONNSESSION) max clients reached in session mode -
     *   max clients are limited to pool_size: 15
     *
     * thrown by whatever query a request happened to run first — the session
     * lookup, the Parcels counts, the panel layout's rows — which is why the
     * operator saw "Application error" on a different screen each time and
     * never twice in a row. /today and /parcels were failing 13% of
     * invocations.
     *
     * The arithmetic: 3 per instance × 5 instances = 15, and Fluid compute
     * SUSPENDS an instance between invocations without running its timers, so
     * `idle_timeout` does not fire while it sleeps (Vercel: "Connection
     * pooling with Vercel Functions"). A few minutes of moving between
     * screens leaves several sleeping instances each holding three
     * connections, and the sixth live request is refused. At 1 per instance
     * the same 15 covers fifteen instances, and a page that runs nine queries
     * runs them down one connection instead of asking for three.
     *
     * The cost is real and small: queries inside one instance queue rather
     * than run in parallel. They are 2–10ms each (Vercel's own P75 for
     * /parcel/[id] is 10ms), so a nine-query page pays tens of milliseconds.
     * A page that renders slightly slower beats a page that does not render.
     */
    max: envNumber('DB_POOL_MAX', process.env.VERCEL ? 1 : 10),
    /*
     * Five seconds, not twenty.
     *
     * This is the only thing that gives a connection back, so it should fire
     * while the instance is still awake — between two page views, not after
     * the operator has moved on. It cannot fire while the instance is
     * suspended, so the shorter window is what makes a sleeping instance more
     * likely to be holding nothing. See `armIdleRelease`, which is the other
     * half of this: it keeps the instance awake long enough for this timer to
     * fire.
     */
    idle_timeout: envNumber('DB_IDLE_TIMEOUT', 5),
    /*
     * Five seconds, not ten.
     *
     * This is the dominant term in how long the operator waits for an error
     * page: a refused connection is retried (see `isConnectionRefusal`), so a
     * pooler that accepts the socket and then does not finish the handshake
     * costs this much per attempt. The pooler is in-region — a healthy connect
     * is milliseconds — so ten seconds of waiting was ten seconds of looking
     * at nothing. `RETRY_BUDGET_MS` is the other half of that bound.
     */
    connect_timeout: envNumber('DB_CONNECT_TIMEOUT', 5),
    /*
     * THE DRIVER DOES NOT GET TO ADD ITS OWN BACKOFF ON TOP OF OURS.
     *
     * postgres.js counts every connection that closes with an error in
     * `options.shared.retries`, SHARED BY THE WHOLE POOL, and makes the next
     * connection attempt wait
     *
     *   (0.5 + random/2) × min(3^retries / 100, 20)  seconds
     *
     * — 3.6 to 7.3 seconds after the sixth failure, and 10 to 20 seconds from
     * the seventh on, until something connects. Every query on the instance
     * queues behind that wait, and our own retries feed it: one page load is a
     * session lookup, four layout loaders and the page's own queries, four
     * attempts each, which is easily enough to put the instance on a
     * ten-second floor for every request that follows.
     *
     * Measured on a built server with Postgres stopped, before this line:
     * /api/sweep-progress answered in 2.6s as designed, /settings then
     * returned nothing at all in 30 seconds — no headers, no log lines — and
     * the next /api/sweep-progress hung too. Supabase's EMAXCONNSESSION
     * arrives as a FATAL during connection startup, so a full pooler counts
     * here exactly the same way: in production this would have been long
     * spinners rather than the 2.5-second error page.
     *
     * `withDbRetry` owns the spacing between attempts (RETRY_DELAYS_MS) and
     * the ceiling on the whole sequence (RETRY_BUDGET_MS). A tenth of a second
     * is all the driver needs on top of that. With this line the same built
     * server answered /settings in 4.2s, /today in 2.7s, and the error page
     * recovered on its own 2.8 seconds after Postgres came back.
     */
    backoff: () => 0.1,
    // Off everywhere, including on the session pooler where it would work.
    // See db/connection.ts.
    prepare: shape.prepare,
    ssl: shape.ssl,
    onnotice: () => {},
  });

  globalForDb.__rsClient = client;
  return client;
}

/** The query builder. Everything that reads or writes goes through this. */
export function getDb(): Db {
  armIdleRelease();
  if (globalForDb.__rsDb) return globalForDb.__rsDb;
  const database = drizzle(getSql(), { schema });
  globalForDb.__rsDb = database;
  return database;
}

/**
 * Whether a database is configured at all — without connecting to it.
 *
 * Used by the screens that want to say "this is not set up yet" instead of
 * throwing a stack trace at somebody.
 */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Rows out of `db.execute()`.
 *
 * It returns either an array or an object with a `rows` property depending on
 * driver internals, and drizzle's types promise neither. Everything that runs
 * raw SQL needs this, so it lives here rather than being copied into each.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * A timestamp a raw query can actually bind.
 *
 * Interpolating a `Date` into a `sql` template throws
 * `ERR_INVALID_ARG_TYPE: Received an instance of Date`. Drizzle only knows a
 * value's type when it can see the column it is compared against, and inside a
 * raw fragment it cannot — so the cast has to be written out. The explicit
 * `::timestamptz` also keeps the comparison indexable, which a bare text
 * parameter would not be.
 *
 * It lives here, next to `rowsOf`, because this has now caught three separate
 * raw queries: the note in lib/views/rows.ts was not enough, so the fix is a
 * function rather than a warning.
 */
export function at(when: Date): SQL {
  return sql`${when.toISOString()}::timestamptz`;
}

/** Shuts the pool down. Scripts and tests only; a request must never call it. */
export async function closeDb(): Promise<void> {
  const client = globalForDb.__rsClient;
  globalForDb.__rsClient = undefined;
  globalForDb.__rsDb = undefined;
  if (client) await client.end({ timeout: 5 });
}

/* ------------------------------------------- giving connections back early */

/**
 * KEEP THE INSTANCE AWAKE LONG ENOUGH FOR THE POOL TO LET GO.
 *
 * Fluid compute suspends an instance between invocations, and a suspended
 * instance does not run timers — so postgres.js' `idle_timeout` never fires
 * and the connection is held until the VM shuts down, minutes later. With 15
 * connections for the whole project that is how a handful of sleeping
 * instances starve the ones serving pages. Vercel's own guide on this
 * ("Efficiently manage database connection pools with Fluid compute") points
 * at `attachDatabasePool` from `@vercel/functions`.
 *
 * WHAT THIS DOES INSTEAD, AND WHY. `@vercel/functions` is not a dependency of
 * this project, and `attachDatabasePool` is written against a `pg`/`mysql2`
 * pool — `idleCount`, `on('connect')`, `end()` — none of which a postgres.js
 * `Sql` has. So this uses the thing that package is itself a wrapper around:
 * the per-invocation request context Vercel puts on `globalThis` under a
 * well-known symbol, and its `waitUntil`, which keeps the instance alive until
 * a promise settles.
 *
 * Each invocation is held a little longer than `idle_timeout` past its own
 * last query, and postgres.js closes its own idle connections on its own
 * schedule. IT CLOSES NOTHING ITSELF — see `holdUntilIdle` for why that is the
 * whole design, and why the hold is per invocation rather than shared.
 *
 * Off Vercel there is no request context, nothing is armed, and the ordinary
 * timer runs because nothing suspends the process.
 */
interface VercelRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

function requestContext(): VercelRequestContext | undefined {
  const holder = (globalThis as Record<symbol, unknown>)[
    Symbol.for('@vercel/request-context')
  ] as { get?: () => VercelRequestContext | undefined } | undefined;
  try {
    return holder?.get?.();
  } catch {
    return undefined;
  }
}

function idleTimeoutMs(): number {
  return envNumber('DB_IDLE_TIMEOUT', 5) * 1000;
}

/**
 * ONE HOLD PER INVOCATION, measured from that invocation's own last query.
 *
 * The version before this handed every invocation the SAME promise, so a
 * request joined a window that other requests kept extending. One minute after
 * it went live the Vercel logs had this:
 *
 *   Vercel Runtime Timeout Error: Task timed out after 10 seconds
 *
 * on /api/sweep-progress — `maxDuration = 10`, one query, answered in
 * milliseconds, and then killed because a shared window kept its invocation
 * alive past its own limit while other requests used the database. The
 * operator never saw it: the JSON had already been sent. It was simply an
 * error in the logs on every busy minute, and `import-reminder` and
 * `push-heartbeat` could meet the same wall.
 *
 * So no invocation waits on anybody else's work. Each one is held until
 * `idle_timeout` plus a second after ITS last query, and the requests that
 * keep the pool busy keep the instance awake themselves — which is the same
 * outcome for the pool and a bounded one for every function.
 *
 * The map is weak and keyed on the request context, so an invocation's hold
 * goes with it. A hold that has already settled is replaced rather than
 * extended: a long cron that queries again after its first hold expired needs
 * a new one, and bumping a settled hold's timestamp would hold nothing.
 */
interface Hold {
  lastUsedAt: number;
  settled: boolean;
}

const holds = new WeakMap<object, Hold>();

export function armIdleRelease(): void {
  const ctx = requestContext();
  if (!ctx?.waitUntil) return;

  const open = holds.get(ctx);
  if (open && !open.settled) {
    // Same invocation, another query: the hold moves with it.
    open.lastUsedAt = Date.now();
    return;
  }

  const hold: Hold = { lastUsedAt: Date.now(), settled: false };
  holds.set(ctx, hold);

  try {
    ctx.waitUntil(holdUntilIdle(hold));
  } catch {
    // An older runtime without waitUntil. The pool behaves as it did before.
    hold.settled = true;
  }
}

/**
 * Resolve once `idle_timeout` has passed since this invocation's last query.
 *
 * It is a wait, not a close. Nothing here ends the pool — the pool is a
 * module-level singleton shared by every request on the instance, and the one
 * thing that must never happen again is a request taking it away from another.
 * That bug is what `closeDb()` in a request path did; see
 * tests/pool-lifetime.test.ts. All this does is keep the instance awake long
 * enough for postgres.js' own `idle_timeout` to fire, which it cannot do while
 * Fluid compute has the instance suspended.
 *
 * The loop re-reads `lastUsedAt` each time it elapses, because the stamp moves
 * when the invocation runs another query — and the one that matters is the
 * LAST one. A fixed timer armed at the first query would close while a page
 * was still loading, which is the leak this exists to prevent. It always
 * settles: nothing but this invocation moves its own stamp, so once the
 * invocation stops querying the wait runs out.
 */
async function holdUntilIdle(hold: Hold): Promise<void> {
  for (;;) {
    const left = (hold.lastUsedAt + idleTimeoutMs() + 1_000) - Date.now();
    if (left <= 0) {
      hold.settled = true;
      return;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, left); });
  }
}

/** Test seam: whether this invocation is still being held open. */
export function idleReleaseArmed(): boolean {
  const ctx = requestContext();
  if (!ctx) return false;
  const hold = holds.get(ctx);
  return Boolean(hold && !hold.settled);
}

/* ------------------------------------------------- a refused connection */

/**
 * The pooler was full, or the connection timed out, BEFORE the query was sent.
 *
 * The distinction is the whole safety of the retry. These four cases all fail
 * on the way in — the pooler refuses the connection, or it never opens — so
 * the query provably did not reach Postgres and running it again cannot write
 * anything twice. Anything else, including a connection that died mid-query,
 * is not retried: there is no way to know from here whether the server
 * committed it.
 */
export function isConnectionRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: unknown } | null;
  if (!e) return false;

  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';

  // Supabase's session pooler answers a connection it cannot place with a
  // FATAL: "max clients reached in session mode - max clients are limited to
  // pool_size: 15". postgres.js surfaces it as XX000 before it sends anything.
  if (/max clients reached/i.test(message)) return true;
  if (code === 'EMAXCONNSESSION') return true;
  // postgres.js' own: `connect_timeout` elapsed with no connection.
  if (code === 'CONNECT_TIMEOUT') return true;
  // The socket never opened.
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') return true;

  return e.cause ? isConnectionRefusal(e.cause) : false;
}

/** 250ms, 750ms, 1.5s. Three tries after the first, then the error stands. */
export const RETRY_DELAYS_MS = [250, 750, 1_500] as const;

/**
 * And the whole sequence gives up after this, however it is spending the time.
 *
 * The delays add up to 2.5 seconds, but an ATTEMPT is not free: a pooler that
 * accepts the socket and then stalls costs `connect_timeout` per go, so four
 * attempts could have been forty seconds of staring at a blank screen —
 * longer than the platform would even keep the invocation alive, which would
 * mean a gateway timeout instead of the error page that knows how to recover.
 * This is the ceiling on the wait before that page appears.
 */
export const RETRY_BUDGET_MS = 4_000;

/**
 * Run a READ and give a refused connection a second chance.
 *
 * Reads only, and the type does not enforce that — the rule is in the hands of
 * whoever wraps a loader. A refusal means the pooler was full for a moment;
 * waiting a quarter of a second is almost always enough, because what filled
 * it was another request that is about to finish. Doing this is the difference
 * between a page that renders a beat late and "Application error: a
 * server-side exception has occurred".
 */
const retrying = new AsyncLocalStorage<true>();

export async function withDbRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  /*
   * ONE LEVEL, WHOEVER NESTS WHOM.
   *
   * These wrappers compose: a page retries a loader that retries, or a loader
   * calls another loader that is itself retryable — `parcelsView` calls
   * `closureCount`. Each level multiplied the one below it, so against a
   * pooler that kept refusing, the waits compounded into twenty-five seconds
   * before the error page appeared, with sixteen connection attempts hammering
   * the very resource that was exhausted.
   *
   * The outermost call owns the retry and every call inside it is a
   * pass-through. AsyncLocalStorage rather than a module flag because one
   * instance serves several requests at once, and a flag would let one
   * request's retry silence another's.
   */
  if (retrying.getStore()) return run();
  return retrying.run(true, () => attemptWithRetries(label, run));
}

async function attemptWithRetries<T>(label: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isConnectionRefusal(err)) throw err;

      const wait = RETRY_DELAYS_MS[attempt];

      if (Date.now() - startedAt + wait > RETRY_BUDGET_MS) {
        // Out of budget: the attempts themselves are taking the time, which
        // means the pooler is not refusing quickly but stalling. The honest
        // answer is the error page, which retries on its own.
        console.warn(`[db] connection refused: out of retry budget — ${label}`);
        throw err;
      }
      // One plain line per refusal, greppable in the Vercel logs, and with
      // nothing in it that could carry a password: the label is ours and the
      // size comes out of the server's own message.
      const size = /pool_size:\s*(\d+)/.exec(String((err as { message?: string }).message ?? ''));
      console.warn(
        `[db] connection refused: pooler full${size ? ` (${size[1]})` : ''}`
        + ` — ${label}, retrying in ${wait}ms`,
      );
      await new Promise((resolve) => { setTimeout(resolve, wait); });
    } finally {
      /*
       * The window is measured from when a query SETTLES, not from when it was
       * built.
       *
       * `getDb()` stamps `lastUsedAt` as the query is issued, and postgres.js
       * starts its own idle timer when the connection goes quiet — when the
       * query comes back. With `max: 1` on Vercel the queries of one page
       * queue behind each other, so the last one can land seconds after it was
       * issued, and a window measured from the issue could close before the
       * pool's timer had even started. One stamp here covers every read that
       * goes through a retry wrapper, which is nearly all of them.
       */
      armIdleRelease();
    }
  }
}

/** The same thing, wrapped round a loader once rather than at every call. */
export function retryableRead<A extends unknown[], R>(
  label: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => withDbRetry(label, () => fn(...args));
}

export { schema };
