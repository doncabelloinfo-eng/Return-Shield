import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

/**
 * The live progress bar.
 *
 * The operator asked to watch a refresh happen rather than look at a button
 * that says "Asking Correos…" for two minutes — which is indistinguishable
 * from a button that has hung.
 *
 * The row lives in `settings`, which is what makes the HOURLY CRON visible
 * too: it writes the same row from a different serverless instance, so anyone
 * with the app open sees the automatic check. That is also what makes "pressing
 * Refresh during a sweep shows that sweep" fall out for free rather than
 * needing a mechanism.
 */

// The poll route authenticates, so the session is stubbed and one test below
// asserts a signed-out request is turned away.
const currentUser = vi.fn(async (): Promise<{ id: string; email: string; name: string } | null> =>
  ({ id: 'u', email: 'op@example.com', name: 'Op' }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  currentUser,
}));
// The Refresh action is a public endpoint whatever the page looks like.
vi.mock('@/lib/auth/guard', () => ({
  requireUser: vi.fn(async () => ({ id: 'u', email: 'op@example.com', name: 'Op' })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { GET } = await import('@/app/api/sweep-progress/route');
const {
  startProgress, progressWriter, readProgress, viewProgress, progressLine,
  duration, roughly, PROGRESS_WRITE_EVERY_MS, PROGRESS_STALE_AFTER_MS, PROGRESS_LINGER_MS,
} = await import('@/lib/sweep-progress');
const { getSetting } = await import('@/lib/settings');
const { reconcile } = await import('@/jobs/definitions');
const { TrackpubClient, setTrackpub } = await import('@/lib/carriers/correos/trackpub');
const { TestClock, resetClock } = await import('@/lib/clock');
const { resetDb, closeDb } = await import('./helpers/db');
const { makeShipment } = await import('./helpers/fixtures');

type LookupResult = import('@/lib/carriers/correos/trackpub').LookupResult;
type Trackpub = InstanceType<typeof TrackpubClient>;

let clock: InstanceType<typeof TestClock>;
const NOW = '2026-10-08T12:00:00+02:00';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
  currentUser.mockClear();
  currentUser.mockResolvedValue({ id: 'u', email: 'op@example.com', name: 'Op' });
});

afterEach(() => { setTrackpub(null); });

afterAll(async () => {
  resetClock();
  await closeDb();
});

describe('the row the sweep writes', () => {
  it('appears before the first request, at nought of however many', async () => {
    // Otherwise the bar materialises a third of the way through, which reads
    // as "it started late" rather than "it started".
    await startProgress({ total: 201, manual: true, at: clock.now() });

    const row = await readProgress();
    expect(row).toMatchObject({ total: 201, checked: 0, changed: 0, manual: true, done: false });
  });

  it('is throttled, so watching the sweep is not what the sweep costs', async () => {
    const row = await startProgress({ total: 10, manual: false, at: clock.now() });
    const write = progressWriter(row);

    // A hundred calls in a tight loop. The first writes; the rest are inside
    // the two-second window and do not.
    for (let i = 1; i <= 100; i += 1) await write({ checked: i, changed: 0 });

    expect((await readProgress())!.checked).toBe(1);
    expect(PROGRESS_WRITE_EVERY_MS).toBe(2000);
  });

  it('always writes the final line, whatever the throttle says', async () => {
    const row = await startProgress({ total: 10, manual: false, at: clock.now() });
    const write = progressWriter(row);

    await write({ checked: 1, changed: 0 });
    await write({ checked: 10, changed: 3, done: true, tookMs: 114_000 }, { force: true });

    const after = await readProgress();
    expect(after).toMatchObject({ checked: 10, changed: 3, done: true, tookMs: 114_000 });
  });

  it('needs no migration, because it is a settings row', async () => {
    await startProgress({ total: 3, manual: true, at: clock.now() });
    // Read through the ordinary settings accessor, which is the point: there
    // is no new table to create against a fork somebody has to click Sync on.
    expect(await getSetting('sweepProgress')).toMatchObject({ total: 3 });
  });
});

describe('what the bar reads', () => {
  const base = {
    total: 201, checked: 87, changed: 12,
    startedAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:50.000Z',
    manual: true, done: false,
  };

  it('counts what is left and guesses how long it has to go', () => {
    const v = viewProgress(base, new Date('2026-10-08T12:00:50.000Z'))!;
    expect(v.state).toBe('running');
    expect(v.left).toBe(114);
    expect(v.seconds).toBe(50);
    // 87 in 50 seconds is 1.74 a second, so 114 left is about 66 seconds.
    expect(v.secondsLeft).toBe(66);
    expect(progressLine(v)).toBe(
      'Checking with Correos: 87 of 201 · 12 changed · 114 left · about a minute left',
    );
  });

  it('labels the hourly run as the automatic one', () => {
    const v = viewProgress({ ...base, manual: false }, new Date('2026-10-08T12:00:50.000Z'))!;
    expect(v.label).toBe('Automatic check');
    expect(progressLine(v)).toContain('Automatic check: 87 of 201');
  });

  it('shows the final count when it ends', () => {
    const v = viewProgress(
      { ...base, checked: 201, changed: 88, done: true, tookMs: 114_000 },
      new Date('2026-10-08T12:01:54.000Z'),
    )!;
    expect(v.state).toBe('finished');
    expect(progressLine(v)).toBe('Checked 201 · 88 changed · 0 left · 1 min 54 s');
  });

  it('says how many are left when it stopped at its budget', () => {
    const v = viewProgress(
      {
        ...base, total: 600, checked: 420, changed: 30, done: true, tookMs: 240_000,
        stoppedEarly: 'ran out of time — the next run continues from here',
      },
      new Date('2026-10-08T12:04:00.000Z'),
    )!;
    expect(progressLine(v)).toBe(
      'Checked 420 of 600 · 30 changed · 180 left · the next check continues from here',
    );
  });

  it('keeps a finished run on screen for a while, then drops it', () => {
    const done = { ...base, checked: 201, done: true, tookMs: 1_000, updatedAt: '2026-10-08T12:01:54.000Z' };
    expect(viewProgress(done, new Date('2026-10-08T12:02:00.000Z'))!.show).toBe(true);
    const later = new Date(Date.parse(done.updatedAt) + PROGRESS_LINGER_MS + 1000);
    expect(viewProgress(done, later)!.show).toBe(false);
  });

  it('drops a run that died rather than leaving the bar at 43% for ever', () => {
    // Serverless instances get killed. A row saying `done: false` with nothing
    // written to it for twelve seconds is a dead run, not a slow one.
    const stale = new Date(Date.parse(base.updatedAt) + PROGRESS_STALE_AFTER_MS + 1000);
    const v = viewProgress(base, stale)!;
    expect(v.state).toBe('abandoned');
    expect(v.show).toBe(false);
  });

  it('is nothing at all when no sweep has ever run', () => {
    expect(viewProgress(null)).toBeNull();
  });

  it('does not divide by zero on a sweep with nothing to do', () => {
    const v = viewProgress({ ...base, total: 0, checked: 0 }, new Date(base.updatedAt))!;
    expect(v.left).toBe(0);
    expect(v.secondsLeft).toBeNull();
  });

  it('rounds the estimate, because a precise one would be a lie', () => {
    expect(roughly(5)).toBe('a few seconds');
    expect(roughly(65)).toBe('a minute');
    expect(roughly(200)).toBe('3 minutes');
    expect(duration(54)).toBe('54 s');
    expect(duration(114)).toBe('1 min 54 s');
    expect(duration(120)).toBe('2 min');
  });
});

describe('the poll route', () => {
  it('needs a login', async () => {
    currentUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorised' });
  });

  it('never lets anything cache a progress reading', async () => {
    await startProgress({ total: 5, manual: true, at: clock.now() });
    const res = await GET();
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('returns the row, worked out, so the client does no arithmetic', async () => {
    const row = await startProgress({ total: 10, manual: true, at: clock.now() });
    await progressWriter(row)({ checked: 4, changed: 1 }, { force: true, at: clock.now() });

    const body = await (await GET()).json() as { progress: Record<string, unknown> | null };

    expect(body.progress).toMatchObject({
      label: 'Checking with Correos',
      state: 'running',
      total: 10,
      checked: 4,
      changed: 1,
      left: 6,
      percent: 40,
      done: false,
    });
    expect(String(body.progress!.line)).toContain('4 of 10');
  });

  it('answers with nothing when there is nothing to show', async () => {
    const body = await (await GET()).json() as { progress: unknown };
    expect(body.progress).toBeNull();
  });
});

describe('a real sweep, end to end', () => {
  /** A trackpub that answers nothing, for codes we only want counted. */
  function quiet() {
    const empty = (): LookupResult => ({
      ok: true, outcome: { events: [], problems: [], errors: [], codesSeen: [] }, raw: {},
    });
    setTrackpub({
      configured: true,
      mode: 'comma',
      diagnosis: null,
      batchSize: 100,
      adoptMode() { /* fixed */ },
      async lookup() { return empty(); },
      async lookupMany(codes: readonly string[]) {
        const byCode = new Map<string, LookupResult>();
        for (const c of codes) byCode.set(c, empty());
        return {
          byCode, notReached: [], mode: 'comma' as const, requests: 1,
          batchDiagnosis: null, batchSize: 100,
        };
      },
    } as unknown as Trackpub);
  }

  it('moves the row while it runs and leaves the final line behind', async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeShipment({ shippingCode: `PQ20000000${i}ES`, state: 'created' });
    }
    quiet();

    await reconcile({ manual: true });

    const v = viewProgress(await readProgress(), clock.now())!;
    expect(v.state).toBe('finished');
    expect(v.total).toBe(3);
    expect(v.checked).toBe(3);
    expect(v.left).toBe(0);
    expect(v.manual).toBe(true);
    expect(progressLine(v)).toContain('Checked 3 · 0 changed · 0 left');
  });

  it('labels the automatic run as automatic, from the same row', async () => {
    await makeShipment({ shippingCode: 'PQ21000000ES', state: 'created' });
    quiet();

    // No `manual`, which is what the cron passes.
    await reconcile({ dueOnly: true });

    const v = viewProgress(await readProgress(), clock.now())!;
    expect(v.manual).toBe(false);
    expect(v.label).toBe('Automatic check');
  });

  it('shows the running sweep to a second press rather than starting another', async () => {
    /*
     * The row is in the database, so the second press does not need a
     * mechanism to find the first sweep — it is already drawing it. The lock
     * is what stops two sweeps, and this is what the operator sees meanwhile.
     */
    const { acquireJobLock, releaseJobLock } = await import('@/lib/job-lock');
    const { refreshFromCorreos } = await import('@/app/actions/refresh');

    await makeShipment({ shippingCode: 'PQ23000000ES', state: 'created' });
    quiet();

    // A sweep in flight: its row is written and its lock is held.
    await startProgress({ total: 201, manual: true, at: clock.now() });
    const held = await acquireJobLock('reconcile', 120);
    expect(held.acquired).toBe(true);

    const second = await refreshFromCorreos();

    expect(second.swept).toBe(false);
    expect(second.message).toContain('already running');
    // And the row still describes the FIRST sweep, untouched.
    const v = viewProgress(await readProgress(), clock.now())!;
    expect(v.total).toBe(201);
    expect(v.checked).toBe(0);
    expect(v.state).toBe('running');

    if (held.acquired) await releaseJobLock(held.lease);
  });

  it('writes no row at all when nothing was due', async () => {
    // A run that ends in milliseconds has nothing to show, and a bar that
    // flickered up and vanished every hour would be worse than none.
    const f = await makeShipment({ shippingCode: 'PQ22000000ES', state: 'in_transit' });
    const { getSql } = await import('@/db');
    await getSql()`
      UPDATE shipments SET last_reconciled_at = ${clock.now().toISOString()}::timestamptz
       WHERE id = ${f.shipmentId}
    `;
    quiet();

    const r = await reconcile({ dueOnly: true });

    expect(r.skipped).toBe(true);
    expect(await readProgress()).toBeNull();
  });
});
