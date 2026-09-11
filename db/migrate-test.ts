import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Brings the test database up to date before the suite runs. Creates it if it
 * is not there, so a fresh checkout is `npm test` and nothing else.
 */
async function main(): Promise<void> {
  const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set');

  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '');
  const testName = name.endsWith('_test') ? name : `${name}_test`;

  // Connect to the maintenance database to create the test one if needed.
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const adminSql = postgres(admin.toString(), { max: 1 });
  const exists = await adminSql`SELECT 1 FROM pg_database WHERE datname = ${testName}`;
  if (!exists.length) {
    await adminSql.unsafe(`CREATE DATABASE "${testName}"`);
    console.log(`created database ${testName}`);
  }
  await adminSql.end();

  url.pathname = `/${testName}`;
  const sql = postgres(url.toString(), { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder: './db/migrations' });
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
