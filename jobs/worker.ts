import 'dotenv/config';
import { PgBoss } from 'pg-boss';
import {
  dailyDigest, drainPushInbox, escalationTick, housekeeping, importReminder,
  pushHeartbeat, rebuildPostcodeStats, reconcile, runJob, shopifyBackfill,
  staleDetector, type JobName,
} from './definitions';
import { loadDemoClock } from '@/lib/demo-clock';

/**
 * The job runner, for local development and for anywhere with a long-running
 * process.
 *
 * In production on Vercel the schedule lives in `vercel.json` and each job is
 * an HTTP route under `app/api/cron/` — see docs/cron.md. This runs the exact
 * same job functions, so it stays useful for working on the loop without
 * deploying, and demo mode needs it: moving the clock is only interesting if
 * the ladder moves with it.
 *
 * pg-boss keeps the schedule in Postgres, so it survives a restart rather than
 * quietly forgetting everything the way a `setInterval` would.
 *
 * Cron expressions here are Madrid time, set explicitly rather than inherited
 * from the server's TZ — unlike Vercel Cron, which is UTC only.
 */

const TZ = 'Europe/Madrid';

const SCHEDULE: { name: JobName; cron: string; fn: () => Promise<{ detail: Record<string, unknown> }> }[] = [
  // Walks live shipments and fires whatever rung is due.
  { name: 'escalation-tick', cron: '*/30 * * * *', fn: escalationTick },
  // Turns staged Correos payloads into events. Often, because the receiver
  // only stages them — until this runs, a countdown has not started.
  { name: 'push-drain', cron: '* * * * *', fn: () => drainPushInbox() },
  // The safety net for push.
  // Locally this can afford to run as often as it does in production.
  { name: 'nightly-reconcile', cron: '10 */2 * * *', fn: () => reconcile() },
  { name: 'stale-detector', cron: '30 7 * * *', fn: staleDetector },
  { name: 'daily-digest', cron: '0 8 * * *', fn: dailyDigest },
  { name: 'push-heartbeat', cron: '0 * * * *', fn: pushHeartbeat },
  { name: 'shopify-backfill', cron: '15 * * * *', fn: shopifyBackfill },
  { name: 'import-reminder', cron: '0 9 * * *', fn: importReminder },
  { name: 'postcode-stats', cron: '45 2 * * *', fn: rebuildPostcodeStats },
  { name: 'housekeeping', cron: '15 4 * * *', fn: housekeeping },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const boss = new PgBoss({
    connectionString: url,
    schema: 'job_queue',
    // Two workers must never run the same tick at once: the engine is
    // idempotent, but doing the same work twice is still wasted Correos quota.
    schedule: true,
  });

  boss.on('error', (err: unknown) => console.error('[worker] pg-boss error:', err));

  await boss.start();

  for (const job of SCHEDULE) {
    await boss.createQueue(job.name).catch(() => { /* already there */ });

    await boss.work(job.name, { batchSize: 1 }, async () => {
      await loadDemoClock();
      await runJob(job.name, job.fn);
    });

    // Re-scheduling with the same name replaces the old entry, so changing a
    // cron here is enough — no manual cleanup, no duplicate schedules.
    await boss.schedule(job.name, job.cron, {}, { tz: TZ });
    console.log(`[worker] ${job.name} scheduled at "${job.cron}" (${TZ})`);
  }

  console.log(`[worker] up with ${SCHEDULE.length} jobs`);

  const stop = async (signal: string) => {
    console.log(`[worker] ${signal} — finishing the job in hand before exiting`);
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});
