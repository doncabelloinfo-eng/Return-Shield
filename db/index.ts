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
    // Serverless runs many short-lived instances against one database, so each
    // one holds a small pool and gives connections back quickly. A generous
    // pool per instance is how a Postgres runs out of connections at 9am.
    //
    // THIS NUMBER IS THE BINDING CONSTRAINT RIGHT NOW. The app is on
    // Supabase's SESSION pooler, port 5432, because transaction mode crossed
    // query parameters between concurrent queries — see the note at the top of
    // db/connection.ts. Session mode gives each client its own backend for the
    // life of the connection, so the ceiling is the project's pool size rather
    // than something large: 15 on this project. At 3 per instance that is five
    // instances holding connections at once, and `idle_timeout: 20` is how
    // long one keeps holding them after it goes quiet.
    //
    // So the sixth concurrent instance waits on `connect_timeout` and then
    // fails. If that starts happening, the pool size is raised in Supabase →
    // Database → Settings; do not raise DB_POOL_MAX against an unchanged
    // ceiling, which just reaches it with fewer instances.
    max: envNumber('DB_POOL_MAX', process.env.VERCEL ? 3 : 10),
    idle_timeout: 20,
    connect_timeout: 10,
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

/** Shuts the pool down. Scripts and tests only; a request must never call it. */
export async function closeDb(): Promise<void> {
  const client = globalForDb.__rsClient;
  globalForDb.__rsClient = undefined;
  globalForDb.__rsDb = undefined;
  if (client) await client.end({ timeout: 5 });
}

export { schema };
