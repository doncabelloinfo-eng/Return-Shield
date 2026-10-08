import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { getDb } from '@/db';
import { jobRuns, shipmentEvents } from '@/db/schema';
import { TestClock, resetClock, MINUTE } from '@/lib/clock';
import { reconcile, runJob } from '@/jobs/definitions';
import { sweepSilence, sweepCapacity } from '@/lib/sweep-health';
import { TrackpubClient, setTrackpub, type LookupResult } from '@/lib/carriers/correos/trackpub';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The day the automatic check stopped learning anything, and what now makes
 * that visible.
 *
 * WHAT HAPPENED. Parcel PKA6TP9800094740148903F showed Pre-admission all day on
 * 8 October while Correos' public tracker had six events for it. Six hourly
 * runs in a row reported "asked 201, changed 0" and stored nothing, and
 * twenty-eight minutes after the last of them a manual Refresh asked the same
 * parcels and got 409 events for 92 of them.
 *
 * THE CAUSE, reproduced on a built server before anything was changed. Next's
 * App Router patches global `fetch`; a GET with no cache option inside a route
 * handler is written to the on-disk Data Cache with `revalidate: 31536000`, a
 * year. Three cron runs against a stub that answered differently each time
 * produced ONE outbound request, and `.next/cache/fetch-cache/<hash>` held the
 * first answer. With `cache: 'no-store'`: three runs, three requests, three
 * answers, empty cache directory.
 *
 * Why it looked intermittent: the bearer token is part of the cache key, so a
 * run that happened to mint a fresh token missed the cache and did get real
 * data. And why Refresh always worked: it is a POST server action, and Next
 * does not cache those.
 *
 * tests/no-store.test.ts guards the fix. THIS file is about the other half of
 * the brief — making silence visible — because the fix cannot be the only
 * defence against a class of failure whose whole character is that every screen
 * looks healthy while it happens.
 */

let clock: TestClock;
const NOW = '2026-10-08T12:00:00+02:00';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
});

afterEach(() => { setTrackpub(null); });

afterAll(async () => {
  resetClock();
  await closeDb();
});

/** A reconcile run as `job_runs` records it. */
async function recordRun(
  detail: Record<string, unknown>,
  opts: { minutesAgo: number; ok?: boolean; skipped?: boolean } = { minutesAgo: 0 },
): Promise<void> {
  const started = new Date(clock.now().getTime() - opts.minutesAgo * MINUTE);
  await getDb().insert(jobRuns).values({
    job: 'reconcile',
    startedAt: started,
    finishedAt: new Date(started.getTime() + 114_000),
    ok: opts.ok ?? true,
    skipped: opts.skipped ?? false,
    detail,
  });
}

describe('three silent runs in a row', () => {
  it('say nothing after one, which can just be a quiet hour', async () => {
    await recordRun({ asked: 201, newEvents: 0 }, { minutesAgo: 10 });
    const s = await sweepSilence();
    expect(s.silentRuns).toBe(1);
    expect(s.warn).toBe(false);
  });

  it('warn after three, and say how many parcels went unanswered', async () => {
    // Exactly the shape of 8 October: every run asked about all 201 and stored
    // nothing at all.
    for (const minutesAgo of [10, 70, 130]) {
      await recordRun({ asked: 201, newEvents: 0 }, { minutesAgo });
    }

    const s = await sweepSilence();
    expect(s.silentRuns).toBe(3);
    expect(s.askedInSilence).toBe(603);
    expect(s.warn).toBe(true);
  });

  it('stop counting at the first run that did store something', async () => {
    await recordRun({ asked: 201, newEvents: 0 }, { minutesAgo: 10 });
    await recordRun({ asked: 201, newEvents: 0 }, { minutesAgo: 70 });
    await recordRun({ asked: 201, newEvents: 32 }, { minutesAgo: 130 });
    await recordRun({ asked: 201, newEvents: 0 }, { minutesAgo: 190 });

    // Newest first, so the count is 2 and stops — not 3 by skipping over a run
    // that worked.
    const s = await sweepSilence();
    expect(s.silentRuns).toBe(2);
    expect(s.warn).toBe(false);
  });

  it('ignore a run too small for its silence to mean anything', async () => {
    // An hourly run with four parcels due and no news is a quiet hour, which
    // is the normal case and must never raise an alarm.
    for (const minutesAgo of [10, 70, 130, 190]) {
      await recordRun({ asked: 4, newEvents: 0 }, { minutesAgo });
    }
    const s = await sweepSilence();
    expect(s.silentRuns).toBe(0);
    expect(s.warn).toBe(false);
  });

  it('ignore the runs that found nothing due', async () => {
    // A skipped run did not ask and learnt nothing, which is not silence.
    for (const minutesAgo of [10, 70, 130]) {
      await recordRun({ skipped: 'nothing was due' }, { minutesAgo, skipped: true });
    }
    expect((await sweepSilence()).warn).toBe(false);
  });

  it('ignore a failed run, which has its own alarm', async () => {
    for (const minutesAgo of [10, 70, 130]) {
      await recordRun({ error: 'boom' }, { minutesAgo, ok: false });
    }
    expect((await sweepSilence()).warn).toBe(false);
  });

  it('do not read runs from before the column existed as silence', async () => {
    // `newEvents` is new in this change. Treating a null as zero would warn on
    // the first day, about runs that may have been perfectly healthy.
    for (const minutesAgo of [10, 70, 130]) {
      await recordRun({ asked: 201 }, { minutesAgo });
    }
    const s = await sweepSilence();
    expect(s.silentRuns).toBe(0);
    expect(s.warn).toBe(false);
  });
});

describe('a real sweep records what it stored', () => {
  function answering(events: number) {
    const make = (code: string): LookupResult => ({
      ok: true,
      raw: {},
      outcome: {
        problems: [],
        errors: [],
        codesSeen: [code],
        events: Array.from({ length: events }, (_, i) => ({
          shippingCode: code,
          eventCode: ['A090000V', 'A010000V', 'P040000V', 'G01L010V'][i % 4],
          eventDesc: 'Prerregistrado',
          occurredAt: new Date(`2026-10-0${i + 1}T10:00:00+02:00`),
          source: 'poll' as const,
          rawPayload: {},
        })),
      },
    });
    setTrackpub({
      configured: true, mode: 'comma', diagnosis: null, batchSize: 100,
      adoptMode() { /* fixed */ },
      async lookup(code: string) { return make(code); },
      async lookupMany(codes: readonly string[]) {
        const byCode = new Map<string, LookupResult>();
        for (const c of codes) byCode.set(c, make(c));
        return {
          byCode, notReached: [], mode: 'comma' as const, requests: 1,
          batchDiagnosis: null, batchSize: 100,
        };
      },
    } as unknown as TrackpubClient);
  }

  it('and a second run of the same answer stores nothing more', async () => {
    await makeShipment({ shippingCode: 'PQ30000001ES', state: 'created' });
    answering(3);

    const first = await runJob('reconcile', () => reconcile({ manual: true }));
    expect(first.detail.newEvents).toBe(3);

    // The same three events again. The UNIQUE index makes the second write a
    // no-op, which is correct — and is also exactly what a cached response
    // looks like from the outside, which is why `newEvents` alone is not the
    // alarm. Three runs in a row are.
    const second = await runJob('reconcile', () => reconcile({ manual: true }));
    expect(second.detail.newEvents).toBe(0);

    expect(await getDb().select().from(shipmentEvents)).toHaveLength(3);
  });

  it('and a run that learns something new says so', async () => {
    await makeShipment({ shippingCode: 'PQ30000002ES', state: 'created' });

    answering(2);
    expect((await runJob('reconcile', () => reconcile({ manual: true }))).detail.newEvents).toBe(2);

    // Correos has moved on — the parcel reached the delivery unit.
    answering(4);
    const next = await runJob('reconcile', () => reconcile({ manual: true }));
    expect(next.detail.newEvents).toBe(2);

    // Which is the thing six hourly runs failed to do on 8 October.
    expect((await sweepSilence()).warn).toBe(false);
  });
});

describe('what Settings shows about capacity and cost', () => {
  it('names the batch size, the throughput and the live count', async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeShipment({ shippingCode: `PQ3100000${i}ES`, state: 'in_transit' });
    }
    // A measured run: 201 parcels in 114 seconds, which is what production did.
    await recordRun({ asked: 201, newEvents: 12, tookMs: 114_000 }, { minutesAgo: 20 });

    const c = await sweepCapacity();

    expect(c.live).toBe(3);
    expect(c.measured).toBe(true);
    // 201/114 ≈ 1.76 a second over a 240-second budget.
    expect(c.perRun).toBeGreaterThan(390);
    expect(c.perRun).toBeLessThan(450);
    expect(c.line).toContain('parcels per run');
    expect(c.line).toContain('3 live');
    expect(c.recheckHours).toBe(12);
    expect(c.urgentRecheckHours).toBe(3);
  });

  it('says how long the checks kept the server alive today', async () => {
    // The cost driver: Vercel bills memory for the whole time a function is
    // alive, and this sweep is almost entirely spent waiting on Correos.
    await recordRun({ asked: 201, newEvents: 0, tookMs: 114_000 }, { minutesAgo: 20 });
    await recordRun({ asked: 201, newEvents: 0, tookMs: 114_000 }, { minutesAgo: 80 });

    const c = await sweepCapacity();
    expect(c.busyMinutesToday).toBe(4); // 2 × 114 s
    expect(c.costLine).toContain('kept the server busy');
  });

  it('admits it is guessing when no run has finished yet', async () => {
    const c = await sweepCapacity();
    expect(c.measured).toBe(false);
    expect(c.line).toContain('estimated');
    expect(c.costLine).toBe('Correos checks have not run yet today');
  });

  it('says every parcel is up to date, or how many are not', async () => {
    const fresh = await sweepCapacity();
    expect(fresh.overdue).toBe(0);
    expect(fresh.line).toContain('every parcel checked in the last 12 hours');

    const { getSql } = await import('@/db');
    const f = await makeShipment({ shippingCode: 'PQ32000001ES', state: 'in_transit' });
    const old = new Date(clock.now().getTime() - 20 * 60 * MINUTE).toISOString();
    await getSql()`
      UPDATE shipments SET last_reconciled_at = ${old}::timestamptz WHERE id = ${f.shipmentId}
    `;

    // No memoisation to defeat: outside a server-component request
    // `perRequest` is a pass-through, so this really re-reads. See
    // lib/per-request.ts.
    const late = await sweepCapacity();
    expect(late.overdue).toBe(1);
    expect(late.line).toContain('1 overdue');
  });
});
