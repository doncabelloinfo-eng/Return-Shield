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

/**
 * The timezone is pinned in vitest.config.mts, not here.
 *
 * It used to be set to Europe/Madrid on this line, which was wrong twice over.
 * Production on Vercel runs in UTC and `TZ` is reserved there, so the suite was
 * exercising a configuration production never uses. And it did not even work
 * reliably: V8 caches the zone on first use, so an assignment here can be too
 * late — and `import 'dotenv/config'` on line 1 loads TZ from .env before this
 * line runs anyway, which meant a developer with TZ in their .env silently ran
 * a different suite from CI.
 *
 * Setting it in the vitest config happens before the worker starts, and dotenv
 * does not overwrite a variable that is already set, so the pin holds either
 * way. The guard below asserts the EFFECTIVE zone rather than the variable,
 * because in a worker `process.env` is a copy and can read back as UTC while
 * the clock is somewhere else entirely.
 */
assertRunningInUtc();

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

/**
 * Fail loudly rather than silently testing the wrong thing.
 *
 * Checked against the effective zone, not `process.env.TZ`: vitest's default
 * `forks` pool makes the assignment work, but under `threads` or `vmThreads`
 * every runtime assignment is a no-op while the variable still reads back as
 * whatever was set. A suite that quietly runs in the developer's own zone is
 * exactly what this replaced.
 */
function assertRunningInUtc(): void {
  const offset = new Date().getTimezoneOffset();
  if (offset !== 0) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    throw new Error(
      `The tests must run in UTC, because production does. This process is in ${zone} `
      + `(offset ${-offset} minutes). TZ is pinned in vitest.config.mts; if you changed `
      + "vitest's `pool`, note that a runtime process.env.TZ assignment is a no-op "
      + 'outside the default forks pool.',
    );
  }
}
