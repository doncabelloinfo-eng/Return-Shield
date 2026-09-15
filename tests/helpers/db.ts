import { getSql, closeDb as shutdownPool } from '@/db';

/**
 * Refuses to truncate anything that is not obviously a test database.
 *
 * This function exists because the alternative — a truncate that quietly wipes
 * whatever DATABASE_URL happens to point at — is one stray `npm test` away
 * from deleting somebody's afternoon.
 */
function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const name = (() => { try { return new URL(url).pathname.replace(/^\//, ''); } catch { return ''; } })();

  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to truncate "${name || url}": the tests only run against a database `
      + 'whose name ends in _test. Set DATABASE_URL_TEST, or create <database>_test.',
    );
  }
}

/**
 * Tests share one Postgres. Truncating everything between files is faster than
 * a migration per test and, more importantly, makes each test state its own
 * fixtures — so a test that only passes because a previous one left a row
 * behind cannot exist.
 */
export async function resetDb(): Promise<void> {
  assertTestDatabase();
  await getSql()`
    TRUNCATE
      shipment_actions, notifications, contact_log, tasks,
      escalation_extras, escalation_fires, shipment_events,
      correos_push_inbox, event_review_queue, activity,
      shipments, orders, offices, stores, import_batches,
      product_rules, postcode_stats, settings, job_runs,
      sessions, users, action_rate_limit
    RESTART IDENTITY CASCADE
  `;
}

/** Tests re-export this so each file can shut the pool down when it finishes. */
export async function closeDb(): Promise<void> {
  await shutdownPool();
}
