import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { authorised, cronRoute } from '@/lib/cron';
import { acquireJobLock } from '@/lib/job-lock';
import { getDb } from '@/db';
import { jobRuns } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { JOB_NAMES, PAUSED_JOB_NAMES } from '@/jobs/definitions';
import { resetDb, closeDb } from './helpers/db';

// Imported by name rather than by a computed path, so adding a cron route
// without adding it here is a compile error rather than a test that quietly
// stops covering it.
import * as dailyDigest from '@/app/api/cron/daily-digest/route';
import * as escalationTick from '@/app/api/cron/escalation-tick/route';
import * as housekeeping from '@/app/api/cron/housekeeping/route';
import * as importReminder from '@/app/api/cron/import-reminder/route';
import * as postcodeStats from '@/app/api/cron/postcode-stats/route';
import * as pushDrain from '@/app/api/cron/push-drain/route';
import * as pushHeartbeat from '@/app/api/cron/push-heartbeat/route';
import * as reconcileRoute from '@/app/api/cron/reconcile/route';
import * as shopifyBackfill from '@/app/api/cron/shopify-backfill/route';
import * as staleDetector from '@/app/api/cron/stale-detector/route';

const ROUTES = {
  'daily-digest': dailyDigest,
  'escalation-tick': escalationTick,
  housekeeping,
  'import-reminder': importReminder,
  'postcode-stats': postcodeStats,
  'push-drain': pushDrain,
  'push-heartbeat': pushHeartbeat,
  reconcile: reconcileRoute,
  'shopify-backfill': shopifyBackfill,
  'stale-detector': staleDetector,
} as const;

/**
 * On Vercel every scheduled job is an HTTP route, which means every scheduled
 * job is also a public URL. One of them emails the team, one sweeps the whole
 * shipment table against a rate-limited API, and one writes to every parcel.
 * None of them may be callable by a stranger.
 */

const SECRET = 'a-cron-secret-that-vercel-generated';

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://shield.example.com/api/cron/daily-digest', { headers });
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { resetClock(); await closeDb(); });

describe('cron authorisation', () => {
  it('accepts the bearer token Vercel sends', () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorised(request({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it('refuses a request with no header at all', () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorised(request())).toBe(false);
  });

  it('refuses the wrong secret', () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorised(request({ authorization: 'Bearer not-the-secret' }))).toBe(false);
  });

  it('refuses a secret that is merely a prefix of the real one', () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorised(request({ authorization: `Bearer ${SECRET.slice(0, 10)}` }))).toBe(false);
  });

  it('refuses the secret without the Bearer scheme', () => {
    process.env.CRON_SECRET = SECRET;
    expect(authorised(request({ authorization: SECRET }))).toBe(false);
  });

  it('refuses everything when CRON_SECRET is not configured', () => {
    // An open endpoint that sweeps every shipment and emails the team is worse
    // than a job that never runs, so an unconfigured deployment refuses rather
    // than waving everything through.
    delete process.env.CRON_SECRET;
    expect(authorised(request({ authorization: 'Bearer anything' }))).toBe(false);
    expect(authorised(request())).toBe(false);
  });

  it('refuses an empty secret, even if the header is empty too', () => {
    process.env.CRON_SECRET = '';
    expect(authorised(request({ authorization: 'Bearer ' }))).toBe(false);
  });
});

describe('every cron route', () => {
  const routes = readdirSync('app/api/cron', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it('is wired up — one per scheduled job', () => {
    expect(routes.sort()).toEqual([
      'daily-digest', 'escalation-tick', 'housekeeping', 'import-reminder',
      'postcode-stats', 'push-drain', 'push-heartbeat', 'reconcile',
      'shopify-backfill', 'stale-detector',
    ]);
  });

  it('has a module for every directory on disk', () => {
    expect(Object.keys(ROUTES).sort()).toEqual(routes.sort());
  });

  it('returns 401 without the secret', async () => {
    process.env.CRON_SECRET = SECRET;

    for (const [name, mod] of Object.entries(ROUTES)) {
      const res = await mod.GET(new Request(`https://shield.example.com/api/cron/${name}`));
      expect(res.status, `${name} should refuse an unauthenticated request`).toBe(401);
    }
  });

  it('returns 401 for a wrong secret too, not just a missing one', async () => {
    process.env.CRON_SECRET = SECRET;

    for (const [name, mod] of Object.entries(ROUTES)) {
      const res = await mod.GET(new Request(`https://shield.example.com/api/cron/${name}`, {
        headers: { authorization: 'Bearer guessed-it' },
      }));
      expect(res.status, `${name} should refuse a wrong secret`).toBe(401);
    }
  });

  it('sets an explicit maxDuration, so nothing is killed mid-run', () => {
    for (const [name, mod] of Object.entries(ROUTES)) {
      expect(typeof mod.maxDuration, `${name} should declare maxDuration`).toBe('number');
      expect(mod.maxDuration).toBeLessThanOrEqual(300);
      expect(mod.runtime).toBe('nodejs');
      expect(mod.dynamic).toBe('force-dynamic');
    }
  });
});

describe('the schedule in vercel.json', () => {
  /*
   * Every cron route is either scheduled or deliberately paused, and nothing
   * is scheduled that has no route.
   *
   * The two push jobs are the paused ones. Their routes, their receiver and
   * their code are all intact — hitting one by hand still works — and they are
   * off the schedule because push is not configured and is not being turned
   * on, so between them they fired three hundred times a day to record "push
   * not configured". This is the test that stops a route quietly falling off
   * the schedule without somebody deciding it should.
   */
  it('schedules every cron route that is not deliberately paused', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };

    const scheduled = config.crons.map((c) => c.path.replace('/api/cron/', '')).sort();
    const routes = readdirSync('app/api/cron', { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();

    expect(scheduled).toEqual([...JOB_NAMES].sort());
    expect(routes).toEqual([...JOB_NAMES, ...PAUSED_JOB_NAMES].sort());
    for (const paused of PAUSED_JOB_NAMES) {
      expect(scheduled).not.toContain(paused);
    }
  });

  it('gives every job a five-field cron expression', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };

    for (const c of config.crons) {
      expect(c.schedule.trim().split(/\s+/), `${c.path} schedule`).toHaveLength(5);
    }
  });

  it('offers the daily jobs an hourly chance, so a dropped tick costs an hour', () => {
    // Vercel schedules in UTC and never retries. Pinning these to the one UTC
    // hour that is 08:00 in Madrid means a single dropped invocation loses the
    // day; hourly plus a "have I already run today" check loses an hour.
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };

    for (const path of ['/api/cron/daily-digest', '/api/cron/stale-detector', '/api/cron/import-reminder']) {
      const cron = config.crons.find((c) => c.path === path);
      expect(cron, `${path} should be scheduled`).toBeDefined();
      expect(cron!.schedule, path).toBe('0 * * * *');
    }
  });

  it('keeps the daily jobs on minute 0, not staggered', () => {
    // Staggering one to minute 20 to "avoid a collision" costs a daily delay
    // rather than a shifted minute: the past-the-hour check first passes at the
    // scheduled minute, so 09:00 would become 09:20 every single day. They are
    // separate functions sharing nothing but Postgres.
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };
    const daily = config.crons.filter((c) => c.schedule === '0 * * * *');
    expect(daily).toHaveLength(3);
  });

  it('sweeps Correos every hour, asking only about what is due', () => {
    /*
     * It used to run every three hours and ask about every live parcel on
     * every run. At 201 parcels and one request each that was 114 seconds of a
     * function being alive, every three hours, to learn that 190 of them had
     * not moved — and Vercel bills the time a function is alive, not the work
     * it does.
     *
     * Hourly is also what makes the three-hour promise for urgent parcels
     * keepable: on a three-hourly schedule one dropped invocation breaks it.
     * See lib/recheck.ts.
     */
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };
    expect(config.crons.find((c) => c.path === '/api/cron/reconcile')?.schedule).toBe('10 * * * *');
  });
});


describe('the daily catch-up guard', () => {
  /**
   * The three daily jobs used to fire at both candidate UTC hours and do
   * nothing unless the Madrid hour matched exactly. That was correct and
   * fragile: Vercel never retries, so one dropped invocation meant the digest
   * never went out and nothing said so.
   *
   * Now they are scheduled hourly and ask two questions instead: is it past
   * the hour in Madrid, and has a real run already happened today?
   */
  function routeAt(madridHour: number) {
    let ran = 0;
    const handler = cronRoute(
      'daily-digest',
      async () => { ran += 1; return { detail: { ok: true } }; },
      { dailyAfterMadridHour: madridHour },
    );
    return { handler, ranCount: () => ran };
  }

  const authed = () => new Request('https://shield.example.com/api/cron/daily-digest', {
    headers: { authorization: `Bearer ${SECRET}` },
  });

  beforeEach(() => { process.env.CRON_SECRET = SECRET; });

  it('does the work once it is past the hour in Madrid', async () => {
    const clock = new TestClock('2026-10-01T08:15:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    const res = await handler(authed());

    expect(res.status).toBe(200);
    expect(ranCount()).toBe(1);
    resetClock();
  });

  it('does nothing before the hour', async () => {
    const clock = new TestClock('2026-10-01T07:15:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    const res = await handler(authed());

    expect(res.status).toBe(200);
    expect(ranCount()).toBe(0);
    expect((await res.json()).skipped).toBe('too early');
    resetClock();
  });

  it('does it once a day, not once an hour', async () => {
    const clock = new TestClock('2026-10-01T08:05:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    await handler(authed());

    // Every later invocation that day finds the work already done.
    for (const hour of [9, 10, 14, 20, 23]) {
      clock.set(`2026-10-01T${String(hour).padStart(2, '0')}:05:00+02:00`);
      const res = await handler(authed());
      expect((await res.json()).skipped).toBe('already done today');
    }

    expect(ranCount()).toBe(1);
    resetClock();
  });

  it('runs again the next Madrid day', async () => {
    const clock = new TestClock('2026-10-01T08:05:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    await handler(authed());
    clock.set('2026-10-02T08:05:00+02:00');
    await handler(authed());

    expect(ranCount()).toBe(2);
    resetClock();
  });

  it('catches up later in the day when the scheduled hour was dropped', async () => {
    // This is the whole point. Vercel missing the 08:00 tick used to mean no
    // digest at all; now the 14:00 tick does it.
    const clock = new TestClock('2026-10-01T14:00:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    await handler(authed());

    expect(ranCount()).toBe(1);
    resetClock();
  });

  it('does not count a failed run as done, so the next hour tries again', async () => {
    const clock = new TestClock('2026-10-01T08:05:00+02:00');
    clock.install();

    let attempts = 0;
    const handler = cronRoute('daily-digest', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the mail server refused it');
      return { detail: { ok: true } };
    }, { dailyAfterMadridHour: 8 });

    const first = await handler(authed());
    expect(first.status).toBe(500);

    clock.set('2026-10-01T09:05:00+02:00');
    const second = await handler(authed());
    expect(second.status).toBe(200);
    expect(attempts).toBe(2);
    resetClock();
  });

  it('does not count a skipped run as done either', async () => {
    const clock = new TestClock('2026-10-01T08:05:00+02:00');
    clock.install();

    let real = 0;
    const handler = cronRoute('daily-digest', async () => {
      real += 1;
      return { detail: { skipped: 'nothing to send' }, skipped: true };
    }, { dailyAfterMadridHour: 8 });

    await handler(authed());
    clock.set('2026-10-01T09:05:00+02:00');
    await handler(authed());

    // A skip proves the scheduler is alive; it does not mean today is handled.
    expect(real).toBe(2);
    resetClock();
  });

  it('checks the secret before anything else', async () => {
    const clock = new TestClock('2026-10-01T08:15:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    const res = await handler(new Request('https://shield.example.com/api/cron/daily-digest'));

    expect(res.status).toBe(401);
    expect(ranCount()).toBe(0);
    resetClock();
  });
});

describe('the lock, through a route', () => {
  const authed = (job: string) => new Request(`https://shield.example.com/api/cron/${job}`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });

  beforeEach(() => { process.env.CRON_SECRET = SECRET; });

  it('lets one of two overlapping invocations do the work', async () => {
    const clock = new TestClock('2026-10-01T10:00:00+02:00');
    clock.install();

    let running = 0;
    let both = false;
    const handler = cronRoute('escalation-tick', async () => {
      running += 1;
      if (running > 1) both = true;
      await new Promise((r) => setTimeout(r, 60));
      running -= 1;
      return { detail: {} };
    }, { maxDurationSeconds: 60 });

    const [a, b] = await Promise.all([handler(authed('escalation-tick')), handler(authed('escalation-tick'))]);
    const bodies = [await a.json(), await b.json()];

    expect(both).toBe(false);
    expect(bodies.filter((x) => x.skipped === 'locked')).toHaveLength(1);
    resetClock();
  });

  it('records the skip, so a locked tick is not invisible', async () => {
    const clock = new TestClock('2026-10-01T10:00:00+02:00');
    clock.install();

    await acquireJobLock('housekeeping', 120);
    const handler = cronRoute('housekeeping', async () => ({ detail: {} }), { maxDurationSeconds: 60 });
    await handler(authed('housekeeping'));

    const rows = await getDb().select().from(jobRuns).where(eq(jobRuns.job, 'housekeeping'));
    expect(rows).toHaveLength(1);
    expect(rows[0].skipped).toBe(true);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].detail).toMatchObject({ skipped: 'locked' });
    resetClock();
  });

  it('frees the lock afterwards, so the next tick is not blocked', async () => {
    const clock = new TestClock('2026-10-01T10:00:00+02:00');
    clock.install();

    let ran = 0;
    const handler = cronRoute('postcode-stats', async () => { ran += 1; return { detail: {} }; }, {
      maxDurationSeconds: 120,
    });

    await handler(authed('postcode-stats'));
    await handler(authed('postcode-stats'));

    expect(ran).toBe(2);
    resetClock();
  });

  it('frees the lock even when the job throws', async () => {
    const clock = new TestClock('2026-10-01T10:00:00+02:00');
    clock.install();

    const handler = cronRoute('stale-detector', async () => { throw new Error('boom'); }, {
      maxDurationSeconds: 60,
    });

    const first = await handler(authed('stale-detector'));
    expect(first.status).toBe(500);

    // Still free: a job that throws must not wedge itself for the lease.
    expect((await acquireJobLock('stale-detector', 60)).acquired).toBe(true);
    resetClock();
  });
});
