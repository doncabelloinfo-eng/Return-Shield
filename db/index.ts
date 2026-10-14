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
     * likely to be holding nothing. See `releaseIdleConnections`, which is the
     * other half of this.
     */
    idle_timeout: envNumber('DB_IDLE_TIMEOUT', 5),
    connect_timeout: 10,
    // Off everywhere, including on the session pooler where it would work.
    // See db/connection.ts.
    prepare: shape.prepare,
    ssl: shape.ssl,
    onnotice: () => {},
  });

  globalForDb.__rsClient = client;
  armIdleRelease();
  return client;
}

/** The query builder. Everything that reads or writes goes through this. */
export function getDb(): Db {
  if (globalForDb.__rsDb) { armIdleRelease(); return globalForDb.__rsDb; }
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
 * It arms a single timer slightly longer than `idle_timeout` and lets
 * postgres.js close its own idle connections on its own schedule. IT CLOSES
 * NOTHING ITSELF, and that is the whole design: the pool is a module-level
 * singleton shared by every request on the instance, and the one thing that
 * must never happen again is a request taking it away from another. That bug
 * is what `closeDb()` in a request path did; see tests/pool-lifetime.test.ts.
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

/** One pending window per instance, however many requests arrive inside it. */
let releasing: Promise<void> | null = null;

export function armIdleRelease(): void {
  if (releasing) return;
  const waitUntil = requestContext()?.waitUntil;
  if (!waitUntil) return;

  // A second of slack on top of `idle_timeout`, so the timer has actually
  // fired and the socket has gone before the instance is allowed to sleep.
  releasing = new Promise<void>((resolve) => {
    setTimeout(resolve, idleTimeoutMs() + 1_000);
  }).finally(() => { releasing = null; });

  try {
    waitUntil(releasing);
  } catch {
    // An older runtime without waitUntil. The pool behaves as it did before.
    releasing = null;
  }
}

/** Test seam: whether a release window is currently armed. */
export function idleReleaseArmed(): boolean {
  return releasing !== null;
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
 * Run a READ and give a refused connection a second chance.
 *
 * Reads only, and the type does not enforce that — the rule is in the hands of
 * whoever wraps a loader. A refusal means the pooler was full for a moment;
 * waiting a quarter of a second is almost always enough, because what filled
 * it was another request that is about to finish. Doing this is the difference
 * between a page that renders a beat late and "Application error: a
 * server-side exception has occurred".
 */
export async function withDbRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !isConnectionRefusal(err)) throw err;

      const wait = RETRY_DELAYS_MS[attempt];
      // One plain line per refusal, greppable in the Vercel logs, and with
      // nothing in it that could carry a password: the label is ours and the
      // size comes out of the server's own message.
      const size = /pool_size:\s*(\d+)/.exec(String((err as { message?: string }).message ?? ''));
      console.warn(
        `[db] connection refused: pooler full${size ? ` (${size[1]})` : ''}`
        + ` — ${label}, retrying in ${wait}ms`,
      );
      await new Promise((resolve) => { setTimeout(resolve, wait); });
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
