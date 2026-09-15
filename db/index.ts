import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

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

  const client = postgres(connectionString(), {
    // Serverless runs many short-lived instances against one database, so each
    // one holds a small pool and gives connections back quickly. A generous
    // pool per instance is how a Postgres runs out of connections at 9am.
    max: Number(process.env.DB_POOL_MAX ?? (process.env.VERCEL ? 3 : 10)),
    idle_timeout: 20,
    connect_timeout: 10,
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

/** Shuts the pool down. Scripts and tests only; a request must never call it. */
export async function closeDb(): Promise<void> {
  const client = globalForDb.__rsClient;
  globalForDb.__rsClient = undefined;
  globalForDb.__rsDb = undefined;
  if (client) await client.end({ timeout: 5 });
}

export { schema };
