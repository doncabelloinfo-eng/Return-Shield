import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  RETRY_BUDGET_MS, RETRY_DELAYS_MS, armIdleRelease, getSql, idleReleaseArmed,
  isConnectionRefusal, retryableRead, withDbRetry,
} from '@/db';
import { closeDb } from './helpers/db';
import {
  NEW_INCIDENT_AFTER_MS, RETRY_ATTEMPTS, RETRY_EVERY_MS, RETRY_FIRST_MS, attemptsSoFar,
  nextErrorRetryMs,
} from '@/lib/error-retry';
import { IDLE_POLL_MS, SWEEP_POLL_MS, nextPollDelay } from '@/lib/poll-schedule';

/**
 * The fifteen connections, and the three things now standing between them and
 * an error page.
 *
 * WHAT HAPPENED. Every error in a week of Vercel logs — 109 of them — was one
 * error:
 *
 *   (EMAXCONNSESSION) max clients reached in session mode -
 *   max clients are limited to pool_size: 15
 *
 * thrown by whichever query a request happened to run first. /today and
 * /parcels were failing 13% of invocations and /api/sweep-progress 17.8%, and
 * the operator saw "Application error: a server-side exception has occurred"
 * on a different screen each time. Nothing was leaking permanently: at a quiet
 * moment `pg_stat_activity` showed no app connections at all. The fifteen were
 * being held by the app's own instances, during use and shortly after it.
 *
 * Supabase Nano gives the project a pool of 15, and the app is on the SESSION
 * pooler (port 5432) because transaction mode crossed query parameters between
 * concurrent queries — see db/connection.ts. In session mode every client
 * holds its own backend, so fifteen is the whole app.
 *
 * THE THREE ANSWERS, and the whole of this file:
 *
 *   · ask for fewer. One connection per instance instead of three
 *     (db/index.ts), one session lookup per request instead of three
 *     (lib/auth/session.ts), one small query for the top bar instead of the
 *     whole table (lib/views/todo.ts), no prefetching of a parcel page per
 *     table row, and a poll that stops when nobody is looking;
 *   · give them back sooner. `idle_timeout` of five seconds, and a window
 *     held open past the response so the timer can actually fire before Fluid
 *     compute suspends the instance;
 *   · survive a refusal. A connection refused on the way in is retried, and
 *     only that.
 */

afterEach(() => { vi.restoreAllMocks(); });

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Verbatim what Supabase's session pooler says when it is full. */
const poolerFull = () => Object.assign(
  new Error('max clients reached in session mode - max clients are limited to pool_size: 15'),
  { code: 'XX000' },
);

/* ========================================================== what is refused */

describe('a refused connection', () => {
  const refusal = (over: Record<string, unknown>) => Object.assign(new Error(String(over.message ?? '')), over);

  it('is what Supabase says when the pooler is full', () => {
    // Verbatim from the logs, including the code postgres.js reports.
    expect(isConnectionRefusal(refusal({
      message: 'max clients reached in session mode - max clients are limited to pool_size: 15',
      code: 'XX000',
      severity_local: 'FATAL',
    }))).toBe(true);
  });

  it('is a connect timeout, which never sent anything either', () => {
    expect(isConnectionRefusal(refusal({ message: 'write CONNECT_TIMEOUT', code: 'CONNECT_TIMEOUT' }))).toBe(true);
    expect(isConnectionRefusal(refusal({ message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('is found through a wrapped cause, which is how Next reports it', () => {
    const outer = refusal({ message: 'Failed to load data' });
    (outer as { cause?: unknown }).cause = refusal({
      message: 'max clients reached in session mode', code: 'XX000',
    });
    expect(isConnectionRefusal(outer)).toBe(true);
  });

  it('is NOT a query that reached the database', () => {
    // The distinction the retry rests on. These three got as far as Postgres,
    // so running them again could write something twice.
    expect(isConnectionRefusal(refusal({
      message: 'duplicate key value violates unique constraint', code: '23505',
    }))).toBe(false);
    expect(isConnectionRefusal(refusal({ message: 'canceling statement due to statement timeout', code: '57014' }))).toBe(false);
    // Ambiguous on purpose: a connection that died mid-query cannot be known
    // to have failed before the server committed.
    expect(isConnectionRefusal(refusal({ message: 'write CONNECTION_CLOSED', code: 'CONNECTION_CLOSED' }))).toBe(false);
  });

  it('is not a null, a string or a plain object', () => {
    expect(isConnectionRefusal(null)).toBe(false);
    expect(isConnectionRefusal(undefined)).toBe(false);
    expect(isConnectionRefusal('max clients reached')).toBe(false);
    expect(isConnectionRefusal({})).toBe(false);
  });
});

/* ================================================================ the retry */

describe('a read that was refused a connection', () => {
  it('is tried again, and the page renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;

    const value = await withDbRetry('test read', async () => {
      calls += 1;
      if (calls === 1) throw poolerFull();
      return 'the rows';
    });

    expect(value).toBe('the rows');
    expect(calls).toBe(2);

    // One plain line per refusal, greppable, and with nothing in it that could
    // carry a password.
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('[db] connection refused: pooler full (15)');
    expect(line).toContain('test read');
    expect(line).not.toMatch(/postgres:\/\/|password/i);
  });

  it('is never tried again when the query reached the database', async () => {
    // The safety of the whole mechanism: a write that got as far as Postgres
    // must not be repeated, whatever it came back with.
    let calls = 0;
    await expect(withDbRetry('a real failure', async () => {
      calls += 1;
      throw Object.assign(new Error('duplicate key value'), { code: '23505' });
    })).rejects.toThrow(/duplicate key/);
    expect(calls).toBe(1);
  });

  it('gives up after three tries rather than hammering a database that is down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;

    await expect(withDbRetry('a full pooler', async () => {
      calls += 1;
      throw poolerFull();
    })).rejects.toThrow(/max clients reached/);

    // The first go and one per delay. The error then stands, and the error
    // boundary takes over: app/(panel)/error.tsx.
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
  }, 20_000);

  it('waits longer each time', () => {
    // A quarter of a second is usually enough, because what filled the pooler
    // is another request that is about to finish.
    expect([...RETRY_DELAYS_MS]).toEqual([250, 750, 1_500]);
  });

  it('does not wrap a value in anything when nothing went wrong', async () => {
    expect(await withDbRetry('fine', async () => 7)).toBe(7);
  });

  it('gives up early when the attempts themselves are eating the time', async () => {
    /*
     * The delays add up to 2.5 seconds, but an attempt is not free. A pooler
     * that accepts the socket and then stalls costs `connect_timeout` per go,
     * so four attempts could have been forty seconds in front of a blank
     * screen — longer than the platform keeps the invocation alive, which
     * would mean a gateway timeout instead of the error page that knows how to
     * recover. The budget is the ceiling on the wait before that page.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;

    const started = Date.now();
    await expect(withDbRetry('a stalling pooler', async () => {
      calls += 1;
      await sleep(RETRY_BUDGET_MS / 2 + 100);
      throw poolerFull();
    })).rejects.toThrow(/max clients/);
    const took = Date.now() - started;

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls, 'it stopped before using all its attempts').toBeLessThan(RETRY_DELAYS_MS.length + 1);
    expect(took, 'the budget plus the attempt that broke it').toBeLessThan(RETRY_BUDGET_MS * 2 + 1_000);
  }, 20_000);

  it('retries at ONE level, however deeply the wrappers nest', async () => {
    /*
     * The twenty-five seconds. Measured in Chromium against a built server:
     * with the pooler refusing, the error page took 25 seconds to appear,
     * because these wrappers compose. The panel layout retried a loader that
     * retried; `parcelsView` retries and calls `closureCount`, which retries.
     * Three levels of four attempts is 64 goes at the database and 52 seconds
     * of waiting, against the one resource that had just run out.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let leafCalls = 0;

    const leaf = retryableRead('leaf', async () => {
      leafCalls += 1;
      throw poolerFull();
    });
    const middle = retryableRead('middle', async () => leaf());

    const started = Date.now();
    await expect(withDbRetry('outer', () => middle())).rejects.toThrow(/max clients/);
    const took = Date.now() - started;

    // Four goes at the body, not four cubed.
    expect(leafCalls).toBe(RETRY_DELAYS_MS.length + 1);
    // And one log line per wait, from the outermost level only.
    expect(warn).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length);

    // 250 + 750 + 1500. The worst case before the error page, not 25 seconds.
    const budget = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(budget).toBe(2_500);
    expect(took).toBeGreaterThanOrEqual(budget - 150);
    expect(took).toBeLessThan(budget + 1_500);
  }, 20_000);

  it('still retries a loader called on its own', async () => {
    // The pass-through is scoped to one async path, not global: a loader
    // outside anybody else's retry is still retried.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const leaf = retryableRead('alone', async () => {
      calls += 1;
      if (calls < 3) throw poolerFull();
      return 'rows';
    });

    expect(await leaf()).toBe('rows');
    expect(calls).toBe(3);
  }, 20_000);

  it('does not let one request\'s retry silence another\'s', async () => {
    // Two requests on one instance, overlapping. A module-level flag would
    // have made the second a pass-through; AsyncLocalStorage keeps them apart.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = [0, 0];
    const run = (i: number) => withDbRetry(`request ${i}`, async () => {
      calls[i] += 1;
      if (calls[i] < 2) throw poolerFull();
      return i;
    });

    expect(await Promise.all([run(0), run(1)])).toEqual([0, 1]);
    expect(calls).toEqual([2, 2]);
  }, 20_000);
});

/* ================================================ giving connections back */

describe('the window that lets the pool let go', () => {
  const SYMBOL = Symbol.for('@vercel/request-context');

  /** One request's context. Vercel gives each invocation its own object. */
  function invocation(): { ctx: { waitUntil: (p: Promise<unknown>) => void }; held: Promise<unknown>[] } {
    const held: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { held.push(p); } };
    return { ctx, held };
  }

  function serving(ctx: unknown): void {
    (globalThis as Record<symbol, unknown>)[SYMBOL] = { get: () => ctx };
  }

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[SYMBOL];
    delete process.env.DB_IDLE_TIMEOUT;
  });

  it('does nothing at all off Vercel, where nothing suspends the process', () => {
    expect(idleReleaseArmed()).toBe(false);
    armIdleRelease();
    expect(idleReleaseArmed()).toBe(false);
  });

  it('asks one invocation to hold it open once, however many queries it runs', async () => {
    process.env.DB_IDLE_TIMEOUT = '1';
    const { ctx, held } = invocation();
    serving(ctx);

    armIdleRelease();
    armIdleRelease();
    armIdleRelease();

    expect(held).toHaveLength(1);
    expect(idleReleaseArmed()).toBe(true);

    await held[0];
    expect(idleReleaseArmed()).toBe(false);
  }, 10_000);

  it('gives every invocation its OWN hold, not a share of one window', async () => {
    /*
     * This is the ten-second timeout, and it is why the hold is per
     * invocation. The version before this handed every request the SAME
     * promise, so one minute after it went live the Vercel logs had
     *
     *   Vercel Runtime Timeout Error: Task timed out after 10 seconds
     *
     * on /api/sweep-progress: `maxDuration = 10`, one query, answered in
     * milliseconds, then killed because a shared window kept its invocation
     * alive past its own limit while other requests used the database.
     */
    process.env.DB_IDLE_TIMEOUT = '1';
    const first = invocation();
    const second = invocation();

    serving(first.ctx);
    armIdleRelease();
    serving(second.ctx);
    armIdleRelease();

    expect(first.held).toHaveLength(1);
    expect(second.held).toHaveLength(1);
    expect(first.held[0]).not.toBe(second.held[0]);

    await Promise.all([first.held[0], second.held[0]]);
  }, 10_000);

  it('does not hold one invocation open while OTHERS keep the pool busy', async () => {
    /*
     * The same bug from the other side. A poll lands on a busy instance, runs
     * its one query and answers — and must then be released on its own
     * schedule, however long the instance stays busy. The requests doing that
     * work hold the instance awake themselves; this one has nothing left to
     * wait for.
     *
     * One second of `DB_IDLE_TIMEOUT`, so the hold is two seconds, against
     * four seconds of other traffic.
     */
    process.env.DB_IDLE_TIMEOUT = '1';
    const poll = invocation();
    const busy = invocation();

    serving(poll.ctx);
    armIdleRelease();
    const started = Date.now();

    let pollSettled = 0;
    void poll.held[0].then(() => { pollSettled = Date.now() - started; });

    // Four seconds of somebody else's queries, every 400ms.
    for (let i = 0; i < 10; i += 1) {
      serving(busy.ctx);
      armIdleRelease();
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }

    // Two seconds after ITS last query, not six seconds after the traffic
    // stopped. A /api/sweep-progress with maxDuration 10 survives this.
    expect(pollSettled, `the poll was held for ${pollSettled}ms`).toBeGreaterThan(1_800);
    expect(pollSettled, `the poll was held for ${pollSettled}ms`).toBeLessThan(3_500);

    serving(busy.ctx);
    await busy.held[0];
  }, 20_000);

  it('stays open until idle_timeout after the LAST query, not the first', async () => {
    /*
     * The leak this exists to stop. A single timer armed at a request's first
     * `getDb()` closed while the request was still working — a page render
     * (Vercel's P75 time to first byte here is three seconds), a cron run, a
     * sweep, an export — so the connection was left idle after the window had
     * already gone, and the instance could be suspended still holding it.
     *
     * Written with a one-second `DB_IDLE_TIMEOUT` so the test takes seconds
     * rather than tens of them. At the production five it is the same shape:
     * a query four seconds in holds that invocation to ten seconds.
     */
    process.env.DB_IDLE_TIMEOUT = '1';
    const { ctx, held } = invocation();
    serving(ctx);

    let settled = false;
    armIdleRelease();
    void held[0].then(() => { settled = true; });

    await sleep(1_200);
    armIdleRelease();
    expect(settled).toBe(false);

    // Past the point where the FIRST query's window would have closed.
    await sleep(1_000);
    expect(settled).toBe(false);
    expect(idleReleaseArmed()).toBe(true);
    // Extended, not duplicated: still one hold for this invocation.
    expect(held).toHaveLength(1);

    await sleep(1_600);
    expect(settled).toBe(true);
    expect(idleReleaseArmed()).toBe(false);
  }, 20_000);

  it('opens a fresh hold for a query that comes after the last one expired', async () => {
    // A long cron: it queries, goes quiet past its hold, then queries again.
    // Bumping a settled hold would hold nothing, so a new one is armed.
    process.env.DB_IDLE_TIMEOUT = '1';
    const { ctx, held } = invocation();
    serving(ctx);

    armIdleRelease();
    await held[0];
    expect(idleReleaseArmed()).toBe(false);

    armIdleRelease();
    expect(held).toHaveLength(2);
    expect(idleReleaseArmed()).toBe(true);
    await held[1];
  }, 20_000);

  it('survives a runtime whose waitUntil throws', () => {
    /*
     * And reports honestly that nothing is holding this invocation open,
     * because nothing is. The production path is `waitUntil` working — it has
     * been watched working in a browser — and this is only about not throwing
     * on a runtime that does not have it.
     */
    const ctx = { waitUntil: () => { throw new Error('not supported here'); } };
    serving(ctx);

    expect(() => armIdleRelease()).not.toThrow();
    expect(idleReleaseArmed()).toBe(false);
  });
});

/* ============================================================== the poll */

describe('how often the browser asks about the sweep', () => {
  it('stops completely while the tab is hidden', () => {
    // The case that mattered: tabs get left open for days, and every one of
    // them was taking a connection three times a minute to draw nothing.
    expect(nextPollDelay({ sweeping: false, hidden: true })).toBeNull();
    expect(nextPollDelay({ sweeping: true, hidden: true })).toBeNull();
  });

  it('is a minute when nothing is running, not twenty seconds', () => {
    expect(nextPollDelay({ sweeping: false, hidden: false })).toBe(IDLE_POLL_MS);
    expect(IDLE_POLL_MS).toBe(60_000);
  });

  it('stays at a second and a half while a sweep is running', () => {
    // The bar has to look live. This is the one case worth the requests.
    expect(nextPollDelay({ sweeping: true, hidden: false })).toBe(SWEEP_POLL_MS);
    expect(SWEEP_POLL_MS).toBe(1_500);
  });
});

/* ====================================================== the error page */

describe('when the error page tries again by itself', () => {
  it('waits three seconds, then every four', () => {
    expect(nextErrorRetryMs(0)).toBe(RETRY_FIRST_MS);
    expect(RETRY_FIRST_MS).toBe(3_000);
    for (let attempt = 1; attempt < RETRY_ATTEMPTS; attempt += 1) {
      expect(nextErrorRetryMs(attempt)).toBe(RETRY_EVERY_MS);
    }
    expect(RETRY_EVERY_MS).toBe(4_000);
  });

  it('keeps trying, which is the whole bug', () => {
    /*
     * It tried once, three seconds in, and stopped. Measured in Chromium
     * against a built server: the page appeared with Postgres down, Postgres
     * came back, and eight seconds later the screen was still the error page —
     * the single attempt had been and gone while the database was still down.
     * Pressing the button did not help either, because `reset()` on its own
     * re-renders the payload that already failed; that half is fixed in
     * app/error.tsx.
     */
    const made: number[] = [];
    for (let attempt = 0; ; attempt += 1) {
      const delay = nextErrorRetryMs(attempt);
      if (delay === null) break;
      made.push(delay);
    }
    expect(made.length).toBeGreaterThan(1);
    expect(made).toHaveLength(RETRY_ATTEMPTS);
    // Recovery lands within about four seconds of the database's, for about
    // the first half minute.
    expect(made.reduce((a, b) => a + b, 0)).toBeGreaterThan(30_000);
  });

  it('stops, so a page left open on a real failure is not asking for ever', () => {
    expect(nextErrorRetryMs(RETRY_ATTEMPTS)).toBeNull();
    expect(nextErrorRetryMs(RETRY_ATTEMPTS + 50)).toBeNull();
    expect(nextErrorRetryMs(-1)).toBeNull();
    expect(nextErrorRetryMs(Number.NaN)).toBeNull();
  });

  it('counts a long gap as a new incident, and a short one as the same', () => {
    // The count lives outside the component — the boundary re-renders its
    // fallback, and global-error reloads the document — so it needs telling
    // when to start from zero again.
    const now = 1_760_000_000_000;
    expect(attemptsSoFar(4, now - 1_000, now)).toBe(4);
    expect(attemptsSoFar(4, now - NEW_INCIDENT_AFTER_MS - 1, now)).toBe(0);
    expect(attemptsSoFar(4, 0, now)).toBe(0);
  });
});

/* ======================================== the driver's own reconnect backoff */

describe('five reads in a row against a database that is not there', () => {
  /**
   * THE WAIT THAT IS NOT OURS.
   *
   * postgres.js counts every connection that closes with an error in a
   * counter shared by the whole pool, and spaces the next attempt by
   * `(0.5 + random/2) × min(3^retries / 100, 20)` seconds — ten to twenty from
   * the seventh failure on, until something connects. Every query on the
   * instance queues behind it, and our retries are what feed it.
   *
   * Measured on a built server with Postgres stopped, before `backoff` was
   * set: /api/sweep-progress answered in 2.6s as designed, /settings then
   * returned NOTHING in thirty seconds — no headers, no log lines — and the
   * next /api/sweep-progress hung as well. A full pooler in production would
   * have been long spinners, not the error page.
   *
   * So the shape that matters is not one read but five in a row: the fifth
   * must be no slower than the first. Without `backoff: () => 0.1` in
   * db/index.ts this test fails on the later reads, by a factor of five or
   * more, which is the whole point of it.
   */
  const REAL_URL = process.env.DATABASE_URL;

  afterEach(async () => {
    await closeDb();
    if (REAL_URL) process.env.DATABASE_URL = REAL_URL;
    else delete process.env.DATABASE_URL;
  });

  it('each settle in about three seconds, and the fifth is not slower than the first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Nothing is listening on port 1, so every connection is refused at once
    // and the only thing that can make these reads slow is a delay somebody
    // chose. 127.0.0.1 also means no TLS — see db/connection.ts.
    process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/nothing';
    // Drop the pool built from the real URL so the next getSql() takes this one.
    await closeDb();

    const took: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = Date.now();
      await expect(
        withDbRetry('a closed port', async () => getSql()`SELECT 1`),
      ).rejects.toThrow();
      took.push(Date.now() - started);
    }

    const all = took.join('ms, ');

    for (const [i, ms] of took.entries()) {
      // Four attempts spaced 250/750/1500 is 2.5s, plus a tenth of a second of
      // driver backoff per attempt. The broken behaviour is ten to twenty
      // seconds PER ATTEMPT, so this bound has room to spare and still cannot
      // be met with the driver's own backoff in play.
      expect(ms, `read ${i + 1} of 5 took ${ms}ms (${all}ms)`).toBeLessThan(5_000);
    }

    expect(took[4], `the fifth must not be slower than the first (${all}ms)`)
      .toBeLessThan(took[0] + 2_000);
  }, 120_000);
});

/* ================================= and the routes that have to live that long */

describe('every route that touches the database', () => {
  /**
   * HAS TO OUTLIVE ITS OWN HOLD.
   *
   * The ten-second timeout came from a hold outlasting the function it was
   * attached to. The hold is now `DB_IDLE_TIMEOUT + 1s` — six seconds by
   * default — measured from that invocation's last query, so every route needs
   * a `maxDuration` above its own work plus six.
   *
   * The work is the part a test cannot measure, so this checks the part it
   * can: that no route declares a limit so short that the hold alone would
   * breach it. `/api/sweep-progress` at 10 is the tightest in the app, and it
   * is the one that was being killed.
   *
   * The other half of the rule is the environment: raising DB_IDLE_TIMEOUT
   * above about eight seconds would put the hold over that same route's limit.
   * That is in .env.example next to the variable, because nothing here can see
   * what production sets it to.
   */
  const HOLD_SECONDS = 5 + 1;

  function routes(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) routes(full, out);
      else if (entry.name === 'route.ts') out.push(relative(process.cwd(), full));
    }
    return out;
  }

  const ROUTES = routes('app/api');

  it('is actually being looked at', () => {
    expect(ROUTES).toContain('app/api/sweep-progress/route.ts');
    expect(ROUTES).toContain('app/api/cron/reconcile/route.ts');
    expect(ROUTES.length).toBeGreaterThanOrEqual(13);
  });

  it('declares a maxDuration with room for the hold', () => {
    const tight: string[] = [];

    for (const file of ROUTES) {
      const m = /export const maxDuration = (\d+);/.exec(readFileSync(file, 'utf8'));
      // A route with no maxDuration takes the platform default, which is above
      // this; only an explicit number can be too small.
      if (!m) continue;
      const seconds = Number(m[1]);
      if (seconds < HOLD_SECONDS + 2) tight.push(`${file} — ${seconds}s`);
    }

    expect(
      tight,
      `the release window holds an invocation ${HOLD_SECONDS}s past its last query, `
      + 'so a route with less than that plus its own work is killed by the platform '
      + 'after answering — an error in the logs the operator never sees',
    ).toEqual([]);
  });
});
