import 'dotenv/config';

/**
 * Tests get their own database, always.
 *
 * Not a nicety: `resetDb()` truncates everything, and pointing that at the
 * database somebody is developing against wipes their work without saying so.
 * If DATABASE_URL_TEST is not set we derive `<database>_test` rather than
 * falling back to DATABASE_URL, and the reset helper refuses to run against a
 * database whose name does not end in `_test`.
 */
function testDatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL_TEST;
  if (explicit) return explicit;

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error('Set DATABASE_URL (or DATABASE_URL_TEST) before running the tests.');
  }

  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '');
  if (name.endsWith('_test')) return base;
  url.pathname = `/${name}_test`;
  return url.toString();
}

process.env.DATABASE_URL = testDatabaseUrl();

// Every date calculation in the app assumes Spanish local time. A test that
// passes in UTC and fails in production is worse than no test at all.
process.env.TZ = 'Europe/Madrid';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'test-secret-at-least-32-characters-long!!';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.WHATSAPP_PROVIDER ??= 'none';
// Never let a test reach a real SMTP server.
delete process.env.SMTP_HOST;

// Tests drive the clock themselves, with TestClock. Demo mode installs its own
// clock from a stored offset and resets it when that offset is zero, which
// would quietly undo a clock a test had just installed — so a developer with
// DEMO_MODE=1 in their .env must not get a different test run from CI.
delete process.env.DEMO_MODE;

// Same reasoning for the integrations: whichever credentials happen to be in a
// developer's .env must not change what the tests exercise. Anything that
// needs one sets it itself.
for (const key of Object.keys(process.env)) {
  if (/^(CORREOS_|SHOPIFY_|WHATSAPP_)/.test(key)) delete process.env[key];
}
process.env.WHATSAPP_PROVIDER = 'none';
