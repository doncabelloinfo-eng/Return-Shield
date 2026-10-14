import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RETRY_DELAYS_MS, armIdleRelease, idleReleaseArmed, isConnectionRefusal, withDbRetry,
} from '@/db';
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
  const poolerFull = () => Object.assign(
    new Error('max clients reached in session mode - max clients are limited to pool_size: 15'),
    { code: 'XX000' },
  );

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
});

/* ================================================ giving connections back */

describe('the window that lets the pool let go', () => {
  const SYMBOL = Symbol.for('@vercel/request-context');

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[SYMBOL];
    delete process.env.DB_IDLE_TIMEOUT;
  });

  it('does nothing at all off Vercel, where nothing suspends the process', () => {
    expect(idleReleaseArmed()).toBe(false);
    armIdleRelease();
    expect(idleReleaseArmed()).toBe(false);
  });

  it('holds the instance open past the response, once, however many requests arrive', async () => {
    process.env.DB_IDLE_TIMEOUT = '1';
    const held: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[SYMBOL] = {
      get: () => ({ waitUntil: (p: Promise<unknown>) => { held.push(p); } }),
    };

    armIdleRelease();
    armIdleRelease();
    armIdleRelease();

    // One window per instance, not one per request — otherwise a busy minute
    // would keep an instance alive for as long as the requests kept coming.
    expect(held).toHaveLength(1);
    expect(idleReleaseArmed()).toBe(true);

    // It is a wait, not a close: nothing here ends the pool, because the pool
    // is shared by every request on the instance. That is the lesson of
    // tests/pool-lifetime.test.ts.
    await held[0];
    expect(idleReleaseArmed()).toBe(false);
  }, 10_000);

  it('survives a runtime whose waitUntil throws', () => {
    (globalThis as Record<symbol, unknown>)[SYMBOL] = {
      get: () => ({ waitUntil: () => { throw new Error('not supported here'); } }),
    };
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
