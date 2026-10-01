import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { connectionShape } from './connection';

/**
 * Run with `npm run db:migrate`. Safe to run twice — drizzle records what it
 * has applied and skips it.
 *
 * Deliberately NOT part of the build. A failed migration must not be able to
 * take the site down on an unrelated deploy, and a build that migrates would
 * try to do so once per deployment, previews included, against whatever
 * database it was handed.
 *
 * Point this at Supabase's SESSION pooler (port 5432), not the transaction
 * pooler the app uses: migrations take advisory locks and run DDL, both of
 * which need a session that stays on one backend.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const shape = connectionShape(url);
  // Never print the URL: it carries the password, and this runs in GitHub
  // Actions on a public repository where the logs are public too.
  console.log(`connecting (${shape.note})`);

  const sql = postgres(url, {
    max: 1,
    ssl: shape.ssl,
    prepare: shape.prepare,
    connect_timeout: 15,
    onnotice: () => {},
  });

  await migrate(drizzle(sql), { migrationsFolder: './db/migrations' });
  await sql.end();
  console.log('migrations applied');
}

main().catch((err) => {
  // Print the message, not the error object: a postgres.js connection error
  // carries the full options including the password.
  console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
