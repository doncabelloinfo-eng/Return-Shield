import 'dotenv/config';
import {
  dailyDigest, drainPushInbox, escalationTick, housekeeping, importReminder,
  pushHeartbeat, rebuildPostcodeStats, reconcile, runJob, shopifyBackfill,
  staleDetector, type JobName,
} from './definitions';
import { loadDemoClock } from '@/lib/demo-clock';
import { getSql, closeDb } from '@/db';

/**
 * Run one job by hand: `npx tsx jobs/run-once.ts daily-digest`.
 *
 * Useful for checking a change without waiting for the schedule, and for the
 * cases where somebody needs to force a reconcile after an outage.
 */
const JOBS: Record<JobName, () => Promise<{ detail: Record<string, unknown> }>> = {
  'escalation-tick': escalationTick,
  'push-drain': () => drainPushInbox(),
  'nightly-reconcile': () => reconcile(),
  'stale-detector': staleDetector,
  'daily-digest': dailyDigest,
  'push-heartbeat': pushHeartbeat,
  'shopify-backfill': shopifyBackfill,
  'import-reminder': importReminder,
  'postcode-stats': rebuildPostcodeStats,
  housekeeping,
};

async function main(): Promise<void> {
  const name = process.argv[2] as JobName | undefined;
  if (!name || !(name in JOBS)) {
    console.error(`Usage: tsx jobs/run-once.ts <job>\n\nJobs: ${Object.keys(JOBS).join(', ')}`);
    process.exit(1);
  }

  await loadDemoClock();
  await runJob(name, JOBS[name]);
  await closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
