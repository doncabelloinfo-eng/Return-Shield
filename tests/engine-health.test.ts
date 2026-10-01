import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDb } from '@/db';
import { jobRuns } from '@/db/schema';
import { TestClock, resetClock, MINUTE, HOUR } from '@/lib/clock';
import {
  engineHealth, jobHealth, JOB_CADENCE, QUIET_FOR_TOO_LONG_MS,
} from '@/lib/engine-health';
import { JOB_NAMES } from '@/jobs/definitions';
import { resetDb, closeDb } from './helpers/db';

/**
 * These tests exist because the engine's own failure is silent. If CRON_SECRET
 * is wrong every route answers 401, the dashboard keeps rendering countdowns,
 * and nothing anywhere says the clock stopped. `engineHealth` is the only thing
 * that would notice — so it is the last place a bug can be allowed to hide.
 *
 * They run against real Postgres rather than a stub on purpose. The first
 * version of `jobHealth` typechecked, passed review and returned a 500 on the
 * Settings screen, because a JS array interpolated into a raw drizzle template
 * becomes a ROW, not an array, and `unnest(row::text[])` is a parse error. No
 * amount of mocking would have caught that; one real query does.
 */

let clock: TestClock;
const NOW = '2026-10-01T10:00:00+02:00';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

async function record(
  job: string,
  startedAt: Date,
  fields: { ok: boolean | null; skipped?: boolean } = { ok: true },
): Promise<void> {
  await getDb().insert(jobRuns).values({
    job,
    startedAt,
    finishedAt: startedAt,
    ok: fields.ok,
    skipped: fields.skipped ?? false,
    detail: {},
  });
}

const ago = (ms: number) => new Date(clock.now().getTime() - ms);

describe('engineHealth', () => {
  it('says never-ran on an empty job_runs table', async () => {
    expect(await engineHealth()).toEqual({ state: 'never-ran' });
  });

  it('is healthy when a run finished inside the window', async () => {
    await record('escalation-tick', ago(10 * MINUTE));

    const health = await engineHealth();
    expect(health.state).toBe('healthy');
    if (health.state !== 'healthy') return;
    expect(health.lastJob).toBe('escalation-tick');
    expect(health.ago).toBe('10 minutes ago');
  });

  it('is stopped once the last run falls outside the window', async () => {
    await record('escalation-tick', ago(QUIET_FOR_TOO_LONG_MS + MINUTE));

    const health = await engineHealth();
    expect(health.state).toBe('stopped');
    if (health.state !== 'stopped') return;
    // The distinction the operator needs: not "quiet" but "quiet since when".
    expect(health.exactWhen).toContain('2026');
    expect(health.ago).toBe('46 minutes ago');
  });

  it('counts a skipped run as a heartbeat', async () => {
    // push-heartbeat declining to alert still proves Vercel fired the route,
    // the secret matched and the database was writable.
    await record('push-heartbeat', ago(5 * MINUTE), { ok: true, skipped: true });
    expect((await engineHealth()).state).toBe('healthy');
  });

  it('does not count a failed run as a heartbeat', async () => {
    await record('reconcile', ago(5 * MINUTE), { ok: false });
    expect((await engineHealth()).state).toBe('never-ran');
  });

  it('does not count a run that was killed mid-flight', async () => {
    // ok IS NULL: the instance died before the catch block. Three states, not
    // two — counting null as success is how a dead engine reads green.
    await record('reconcile', ago(5 * MINUTE), { ok: null });
    expect((await engineHealth()).state).toBe('never-ran');
  });

  it('ignores rows dated in the future rather than reading them as healthy', async () => {
    // Demo mode stamps started_at from an offset clock; resetting the offset
    // leaves those rows days ahead for ever.
    await record('escalation-tick', new Date(clock.now().getTime() + 3 * HOUR));
    const health = await engineHealth();
    expect(health.state).toBe('healthy');
    if (health.state !== 'healthy') return;
    expect(health.ago).toBe('just now');
  });

  it('stays quiet in demo mode', async () => {
    process.env.DEMO_MODE = '1';
    try {
      await record('escalation-tick', ago(8 * HOUR));
      expect(await engineHealth()).toEqual({ state: 'unknown' });
    } finally {
      delete process.env.DEMO_MODE;
    }
  });
});

describe('jobHealth', () => {
  it('runs at all', async () => {
    // The regression test. This threw 42846 and took the Settings screen with
    // it; everything else in this block was green at the time.
    await expect(jobHealth()).resolves.toBeDefined();
  });

  it('lists every job, in the roster order, even with no runs recorded', async () => {
    const rows = await jobHealth();
    expect(rows.map((r) => r.job)).toEqual([...JOB_NAMES]);
    expect(rows.every((r) => r.lastHeartbeatAt === null)).toBe(true);
    expect(rows.every((r) => r.lastRealRunAt === null)).toBe(true);
    expect(rows.every((r) => r.failingSince === null)).toBe(true);
  });

  it('distinguishes the last heartbeat from the last real run', async () => {
    await record('reconcile', ago(4 * HOUR));
    await record('reconcile', ago(30 * MINUTE), { ok: true, skipped: true });

    const row = (await jobHealth()).find((r) => r.job === 'reconcile')!;
    expect(row.lastHeartbeatAgo).toBe('30 minutes ago');
    expect(row.lastRealRunAgo).toBe('4 hours ago');
  });

  it('leaves the real run null for a job that has only ever skipped', async () => {
    await record('push-drain', ago(2 * MINUTE), { ok: true, skipped: true });

    const row = (await jobHealth()).find((r) => r.job === 'push-drain')!;
    expect(row.lastHeartbeatAgo).toBe('2 minutes ago');
    expect(row.lastRealRunAt).toBeNull();
  });

  it('reports a failure only while it is the newest attempt', async () => {
    await record('shopify-backfill', ago(3 * HOUR), { ok: false });
    let row = (await jobHealth()).find((r) => r.job === 'shopify-backfill')!;
    expect(row.failingSinceAgo).toBe('3 hours ago');

    // Recovered. The scar must not outlive the wound.
    await record('shopify-backfill', ago(10 * MINUTE));
    row = (await jobHealth()).find((r) => r.job === 'shopify-backfill')!;
    expect(row.failingSince).toBeNull();
    expect(row.lastRealRunAgo).toBe('10 minutes ago');
  });

  it('keeps one job\'s runs out of another job\'s row', async () => {
    await record('daily-digest', ago(20 * MINUTE));

    const rows = await jobHealth();
    expect(rows.find((r) => r.job === 'daily-digest')!.lastRealRunAt).not.toBeNull();
    expect(rows.find((r) => r.job === 'housekeeping')!.lastHeartbeatAt).toBeNull();
  });

  it('ignores job_runs rows for jobs that no longer exist', async () => {
    // `job` is free text and the table still holds `nightly-reconcile` from
    // before the rename. The roster comes from the union, not the data.
    await record('nightly-reconcile', ago(5 * MINUTE));

    const rows = await jobHealth();
    expect(rows.map((r) => r.job)).toEqual([...JOB_NAMES]);
  });
});

describe('the cadence table and vercel.json', () => {
  it('describes exactly the jobs that are scheduled', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };
    const scheduled = config.crons
      .map((c) => c.path.replace('/api/cron/', ''))
      .sort();

    expect(scheduled).toEqual([...JOB_NAMES].sort());
    expect(Object.keys(JOB_CADENCE).sort()).toEqual([...JOB_NAMES].sort());
  });
});
