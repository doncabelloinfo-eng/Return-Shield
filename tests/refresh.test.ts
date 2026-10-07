import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';

// A server action is a public endpoint whatever the page around it looks like,
// so the guard is stubbed with a spy and one test below asserts it is called.
const requireUser = vi.fn(async () => ({ id: 'u', email: 'op@example.com', name: 'Op' }));
vi.mock('@/lib/auth/guard', () => ({ requireUser }));
// revalidatePath needs a request scope, which there is none of here.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { refreshFromCorreos, MANUAL_SWEEP_GAP_MS } = await import('@/app/actions/refresh');
const { getDb, getSql } = await import('@/db');
const { jobRuns, shipmentEvents, shipments } = await import('@/db/schema');
const { acquireJobLock, releaseJobLock } = await import('@/lib/job-lock');
const { sweepStatus } = await import('@/lib/engine-health');
const { TestClock, resetClock, MINUTE } = await import('@/lib/clock');
const { resetDb, closeDb } = await import('./helpers/db');
const { makeShipment } = await import('./helpers/fixtures');

/**
 * The Refresh button.
 *
 * The thing worth guarding is that it is the SAME sweep as the three-hourly
 * cron, sharing the same `job_locks` row — not a second code path that happens
 * to do something similar. Two sweeps at once would spend the Correos quota
 * twice on the same parcels and race each other's `last_reconciled_at` stamps,
 * which is the cursor the whole sweep depends on.
 */

let clock: InstanceType<typeof TestClock>;

/** Enough of Correos to answer, without a network. */
function stubCorreos(answer: (codes: string[]) => unknown): void {
  process.env.CORREOS_CLIENT_ID = 'gw-id';
  process.env.CORREOS_CLIENT_SECRET = 'gw-secret';
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  process.env.CORREOS_JWT = `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 1800 })}.sig`;

  vi.stubGlobal('fetch', (async (url: unknown) => {
    const codes = String(url).split('/').pop()?.split(',') ?? [];
    return new Response(JSON.stringify(answer(codes)), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch);
}

/** A trackpub v2 answer saying each code reached the counter today. */
const atOfficeFor = (codes: string[]) => codes.map((code) => ({
  code,
  events: [{
    eventCode: 'H01I350V',
    summaryText: 'A disposición del destinatario',
    phaseDes: 'EN ENTREGA',
    fecEvento: '07/10/2026',
    eventHours: '11:00:00',
  }],
}));

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T12:00:00+02:00');
  clock.install();
  requireUser.mockClear();
  vi.unstubAllGlobals();
  delete process.env.CORREOS_JWT;
  delete process.env.CORREOS_CLIENT_ID;
  delete process.env.CORREOS_CLIENT_SECRET;
});

afterAll(async () => {
  resetClock();
  vi.unstubAllGlobals();
  await closeDb();
});

describe('pressing Refresh', () => {
  it('asks for a login first', async () => {
    await refreshFromCorreos();
    expect(requireUser).toHaveBeenCalled();
  });

  it('runs the sweep over live parcels and leaves the finished ones alone', async () => {
    const live = await makeShipment({ shippingCode: 'PQ90000001ES', state: 'in_transit' });
    const done = await makeShipment({ shippingCode: 'PQ90000002ES', state: 'delivered' });
    stubCorreos(atOfficeFor);

    const r = await refreshFromCorreos();

    expect(r.ok).toBe(true);
    expect(r.swept).toBe(true);
    expect(r.message).toBe('Checked 1 parcel with Correos · 1 changed');

    // The live one moved; the delivered one was never asked about.
    const after = await getDb().select().from(shipments).where(eq(shipments.id, live.shipmentId));
    expect(after[0].state).toBe('at_office');
    const events = await getDb().select().from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, done.shipmentId));
    expect(events).toHaveLength(0);
  });

  it('counts parcels rather than events', async () => {
    await makeShipment({ shippingCode: 'PQ90000003ES', state: 'in_transit' });
    await makeShipment({ shippingCode: 'PQ90000004ES', state: 'in_transit' });
    // Three events each. "6 changed" would be a count of events, not parcels.
    stubCorreos((codes) => codes.map((code) => ({
      code,
      events: [
        { eventCode: 'A090000V', summaryText: 'Prerregistrado', fecEvento: '05/10/2026', eventHours: '09:00:00' },
        { eventCode: 'A010000V', summaryText: 'Admitido.', fecEvento: '05/10/2026', eventHours: '18:00:00' },
        { eventCode: 'P040000V', summaryText: 'Clasificado', fecEvento: '06/10/2026', eventHours: '04:00:00' },
      ],
    })));

    const r = await refreshFromCorreos();
    expect(r.message).toBe('Checked 2 parcels with Correos · 2 changed');
  });

  it('reports nothing changed when Correos has nothing new', async () => {
    await makeShipment({ shippingCode: 'PQ90000005ES', state: 'in_transit' });
    stubCorreos(() => []);

    // One parcel asked about, nothing learnt. "Checked" counts the parcels
    // the sweep put to Correos, which is the number the operator wants: it
    // says the sweep covered the parcel, and "0 changed" says the answer was
    // the same as last time.
    const r = await refreshFromCorreos();
    expect(r.message).toBe('Checked 1 parcel with Correos · 0 changed');
  });

  it('records the run as an ordinary reconcile run, flagged manual', async () => {
    await makeShipment({ shippingCode: 'PQ90000006ES', state: 'in_transit' });
    stubCorreos(atOfficeFor);

    await refreshFromCorreos();

    const runs = await getDb().select().from(jobRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].job).toBe('reconcile');
    expect(runs[0].ok).toBe(true);
    expect((runs[0].detail as Record<string, unknown>).manual).toBe(true);

    // Which is also what "Last checked …" reads.
    const status = await sweepStatus(clock.now());
    expect(status.ago).toBe('less than a minute ago');
    expect(status.lastManualAt).not.toBeNull();
  });
});

describe('the five-minute guard', () => {
  it('does not start a second sweep inside the gap', async () => {
    await makeShipment({ shippingCode: 'PQ90000007ES', state: 'in_transit' });
    stubCorreos(atOfficeFor);

    const first = await refreshFromCorreos();
    expect(first.swept).toBe(true);

    clock.advanceMinutes(2);
    const second = await refreshFromCorreos();

    expect(second.swept).toBe(false);
    expect(second.message).toContain('Already checked');
    expect(second.message).toContain('3 minutes');
    // One run recorded, not two.
    expect(await getDb().select().from(jobRuns)).toHaveLength(1);
  });

  it('lets a sweep through once the gap has passed', async () => {
    await makeShipment({ shippingCode: 'PQ90000008ES', state: 'in_transit' });
    stubCorreos(atOfficeFor);

    await refreshFromCorreos();
    clock.advanceMs(MANUAL_SWEEP_GAP_MS + MINUTE);
    const again = await refreshFromCorreos();

    expect(again.swept).toBe(true);
    expect(await getDb().select().from(jobRuns)).toHaveLength(2);
  });
});

describe('the lock the button and the cron share', () => {
  it('will not run while the cron sweep holds it', async () => {
    await makeShipment({ shippingCode: 'PQ90000009ES', state: 'in_transit' });
    stubCorreos(atOfficeFor);

    const held = await acquireJobLock('reconcile', 120);
    expect(held.acquired).toBe(true);

    const r = await refreshFromCorreos();

    expect(r.swept).toBe(false);
    expect(r.message).toContain('already running');
    expect(await getDb().select().from(jobRuns)).toHaveLength(0);

    if (held.acquired) await releaseJobLock(held.lease);
  });

  it('gives the lock back, so the next cron tick is not blocked', async () => {
    await makeShipment({ shippingCode: 'PQ90000010ES', state: 'in_transit' });
    stubCorreos(atOfficeFor);

    await refreshFromCorreos();

    // The cron would take it next, which it cannot do if the button kept it.
    const after = await acquireJobLock('reconcile', 60);
    expect(after.acquired).toBe(true);
    if (after.acquired) await releaseJobLock(after.lease);
  });

  it('blocks the cron while the button is mid-sweep', async () => {
    await makeShipment({ shippingCode: 'PQ90000011ES', state: 'in_transit' });

    // Correos answers only once the cron has tried and failed to take the
    // lock, so the two are genuinely overlapping rather than sequential.
    let cronResult: Awaited<ReturnType<typeof acquireJobLock>> | null = null;
    stubCorreos(() => {
      throw new Error('unreachable');
    });
    vi.stubGlobal('fetch', (async (url: unknown) => {
      cronResult = await acquireJobLock('reconcile', 60);
      const codes = String(url).split('/').pop()?.split(',') ?? [];
      return new Response(JSON.stringify(atOfficeFor(codes)), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch);

    const r = await refreshFromCorreos();

    expect(r.swept).toBe(true);
    expect(cronResult!.acquired).toBe(false);
  });
});

describe('a sweep cut short', () => {
  it('says how many are left to check', async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeShipment({ shippingCode: `PQ9100000${i}ES`, state: 'in_transit' });
    }

    /*
     * The budget runs out while Correos is answering, which is the real shape
     * of this failure: the sweep stops between requests rather than being
     * killed mid-request, and the parcels it never reached keep their old
     * stamp so they lead the queue next time. The ordering IS the cursor.
     */
    process.env.MANUAL_SWEEP_BUDGET_MS = '1';
    process.env.RECONCILE_BATCH_SIZE = '1';
    try {
      stubCorreos(atOfficeFor);
      const r = await refreshFromCorreos();
      expect(r.ok).toBe(true);
      expect(r.message).toContain('still to check');
      expect(r.message).toContain('they go first next time');
    } finally {
      delete process.env.MANUAL_SWEEP_BUDGET_MS;
      delete process.env.RECONCILE_BATCH_SIZE;
    }
  });
});

describe('with Correos not configured', () => {
  it('says so rather than claiming a check happened', async () => {
    await makeShipment({ shippingCode: 'PQ92000001ES', state: 'in_transit' });

    const r = await refreshFromCorreos();

    expect(r.swept).toBe(false);
    expect(r.message).toContain('credentials are not configured');
  });
});

describe('after a confirmed upload', () => {
  it('asks Correos about the new parcels and nothing else', async () => {
    const { sweepNewParcels } = await import('@/app/actions/refresh');

    // One parcel checked an hour ago, one that has never been asked about —
    // which is what an upload leaves behind.
    const known = await makeShipment({ shippingCode: 'PQ93000001ES', state: 'in_transit' });
    await getSql()`UPDATE shipments SET last_reconciled_at = now() WHERE id = ${known.shipmentId}`;
    const fresh = await makeShipment({ shippingCode: 'PQ93000002ES', state: 'created' });

    stubCorreos(atOfficeFor);
    const r = await sweepNewParcels();

    expect(r.ok).toBe(true);
    expect(Number(r.detail?.asked)).toBe(1);

    const after = await getDb().select().from(shipments).where(eq(shipments.id, fresh.shipmentId));
    expect(after[0].state).toBe('at_office');
    const untouched = await getDb().select().from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, known.shipmentId));
    expect(untouched).toHaveLength(0);
  });

  it('is the ImportScreen that starts it, right after the confirm', () => {
    // The button and the sweep are two requests on purpose — both are bounded
    // by the same function limit, so running the sweep inside the commit would
    // give it whatever seconds the commit left over. This is the wiring that
    // was missing on 7 October, when eighty-one uploaded TikTok parcels sat in
    // Pre-admission because nothing asked Correos about them.
    const src = readFileSync('components/ImportScreen.tsx', 'utf8');
    expect(src).toContain('sweepNewParcels');
    expect(src.indexOf('confirmUpload(result.filename')).toBeLessThan(src.indexOf('await sweepNewParcels()'));
  });
});
