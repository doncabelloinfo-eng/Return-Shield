import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { authorised, cronRoute } from '@/lib/cron';
import { TestClock, resetClock } from '@/lib/clock';
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
  it('has an entry for every cron route, and no entry without one', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };

    const scheduled = config.crons.map((c) => c.path.replace('/api/cron/', '')).sort();
    const routes = readdirSync('app/api/cron', { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();

    expect(scheduled).toEqual(routes);
  });

  it('gives every job a five-field cron expression', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };

    for (const c of config.crons) {
      expect(c.schedule.trim().split(/\s+/), `${c.path} schedule`).toHaveLength(5);
    }
  });

  it('fires the hour-sensitive jobs at both candidate UTC hours', () => {
    // Madrid is UTC+1 or UTC+2 depending on the season. A single UTC hour would
    // be right for half the year; two, with the job checking which is real, is
    // right all of it.
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };

    for (const path of ['/api/cron/daily-digest', '/api/cron/stale-detector', '/api/cron/import-reminder']) {
      const cron = config.crons.find((c) => c.path === path);
      expect(cron, `${path} should be scheduled`).toBeDefined();
      const hours = cron!.schedule.split(/\s+/)[1];
      expect(hours, `${path} should fire at two hours`).toMatch(/^\d+,\d+$/);
    }
  });
});


describe('the Madrid-hour guard', () => {
  /**
   * Vercel schedules in UTC and Madrid is UTC+1 or UTC+2 depending on the
   * season, so the three jobs where the hour is the point fire at both
   * candidate UTC hours and this decides which one is real.
   */
  function routeAt(madridHour: number) {
    let ran = 0;
    const handler = cronRoute(
      'daily-digest',
      async () => { ran += 1; return { detail: { ok: true } }; },
      { onlyAtMadridHour: madridHour },
    );
    return { handler, ranCount: () => ran };
  }

  const authed = () => new Request('https://shield.example.com/api/cron/daily-digest', {
    headers: { authorization: `Bearer ${SECRET}` },
  });

  beforeEach(() => { process.env.CRON_SECRET = SECRET; });

  it('does the work when it is the right hour in Madrid', async () => {
    const clock = new TestClock('2026-09-01T08:15:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    const res = await handler(authed());

    expect(res.status).toBe(200);
    expect(ranCount()).toBe(1);
    resetClock();
  });

  it('does nothing on the other half of the pair', async () => {
    const clock = new TestClock('2026-09-01T07:15:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    const res = await handler(authed());

    expect(res.status).toBe(200);
    expect(ranCount()).toBe(0);
    expect((await res.json()).skipped).toMatch(/it is 7:00 in Madrid/);
    resetClock();
  });

  it('lands on the right hour in winter, when Madrid is UTC+1', async () => {
    // 06:00 UTC is 07:00 in Madrid in winter and 08:00 in summer. The pair of
    // schedules covers both; this is the winter one firing for stale-detector
    // and not for the digest.
    const clock = new TestClock('2026-12-01T06:30:00Z');
    clock.install();

    const digest = routeAt(8);
    expect((await digest.handler(authed())).status).toBe(200);
    expect(digest.ranCount()).toBe(0);

    const stale = routeAt(7);
    await stale.handler(authed());
    expect(stale.ranCount()).toBe(1);
    resetClock();
  });

  it('lands on the right hour in summer, when Madrid is UTC+2', async () => {
    const clock = new TestClock('2026-07-01T06:30:00Z');
    clock.install();

    const digest = routeAt(8);
    await digest.handler(authed());
    expect(digest.ranCount()).toBe(1);

    const stale = routeAt(7);
    await stale.handler(authed());
    expect(stale.ranCount()).toBe(0);
    resetClock();
  });

  it('checks the secret before it checks the hour', async () => {
    const clock = new TestClock('2026-09-01T08:15:00+02:00');
    clock.install();

    const { handler, ranCount } = routeAt(8);
    const res = await handler(new Request('https://shield.example.com/api/cron/daily-digest'));

    expect(res.status).toBe(401);
    expect(ranCount()).toBe(0);
    resetClock();
  });
});
