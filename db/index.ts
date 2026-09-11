import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * One pool per process. Next.js hot-reloads modules in development, so the
 * client is parked on globalThis — otherwise every save leaks a pool until
 * Postgres refuses new connections.
 */
const globalForDb = globalThis as unknown as { __rsClient?: postgres.Sql };

function client(): postgres.Sql {
  if (globalForDb.__rsClient) return globalForDb.__rsClient;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 20,
    onnotice: () => {},
  });

  if (process.env.NODE_ENV !== 'production') globalForDb.__rsClient = sql;
  return sql;
}

export const sql = client();
export const db = drizzle(sql, { schema });
export type Db = typeof db;
export { schema };
