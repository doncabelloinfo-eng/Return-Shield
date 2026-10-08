import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { getDb, getSql } from '@/db';
import { jobRuns } from '@/db/schema';
import { TestClock, resetClock, HOUR } from '@/lib/clock';
import { reconcile } from '@/jobs/definitions';
import {
  countDue, countLive, countOverdue, isDue, recheckHours, urgentRecheckHours,
  DEFAULT_RECHECK_HOURS, DEFAULT_URGENT_RECHECK_HOURS, URGENT_STATES,
} from '@/lib/recheck';
import { TrackpubClient, setTrackpub, type LookupResult } from '@/lib/carriers/correos/trackpub';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * Every live parcel checked at least every twelve hours, every three for the
 * ones about to go somewhere, and finished parcels never.
 *
 * The rule replaced a sweep that asked about EVERY live parcel on EVERY run.
 * At 201 parcels and one request each that was 114 seconds of a function being
 * alive, every three hours, to learn that 190 of them had not moved. Vercel
 * bills the time a function is alive rather than the work it does, so the way
 * to make this cheaper is to ask about fewer parcels — and the way to keep a
 * three-hour promise while doing that is to run every hour.
 *
 * The rule is written twice, as `isDue` for one row and as SQL for the queue,
 * because loading thirty thousand rows to pick two hundred is not an option.
 * These tests drive both against the same cases, which is the only thing that
 * keeps the two honest.
 */

let clock: TestClock;
const NOW = '2026-10-08T12:00:00+02:00';

beforeEach(async () => {
  await resetDb();
  clock = new TestClock(NOW);
  clock.install();
  delete process.env.RECHECK_HOURS;
  delete process.env.URGENT_RECHECK_HOURS;
});

afterEach(() => {
  setTrackpub(null);
  delete process.env.RECHECK_HOURS;
  delete process.env.URGENT_RECHECK_HOURS;
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

/** A parcel last checked `hours` ago, in the given state. */
async function parcel(code: string, state: string, hours: number | null): Promise<string> {
  const f = await makeShipment({ shippingCode: code, state });
  if (hours === null) {
    await getSql()`UPDATE shipments SET last_reconciled_at = NULL WHERE id = ${f.shipmentId}`;
  } else {
    // An ISO string with an explicit cast, not a bare Date: the driver cannot
    // tell what type a parameter is without a column to look at.
    const at = new Date(clock.now().getTime() - hours * HOUR).toISOString();
    await getSql()`
      UPDATE shipments SET last_reconciled_at = ${at}::timestamptz WHERE id = ${f.shipmentId}
    `;
  }
  return f.shipmentId;
}

/** A trackpub that answers nothing and records what it was asked. */
function stub() {
  const asked: string[] = [];
  const empty = (): LookupResult => ({
    ok: true, outcome: { events: [], problems: [], errors: [], codesSeen: [] }, raw: {},
  });
  setTrackpub({
    configured: true,
    mode: 'comma',
    diagnosis: null,
    batchSize: 100,
    adoptMode() { /* fixed */ },
    async lookup(code: string) { asked.push(code); return empty(); },
    async lookupMany(codes: readonly string[]) {
      const byCode = new Map<string, LookupResult>();
      for (const c of codes) { asked.push(c); byCode.set(c, empty()); }
      return {
        byCode, notReached: [], mode: 'comma' as const, requests: 1,
        batchDiagnosis: null, batchSize: 100,
      };
    },
  } as unknown as TrackpubClient);
  return asked;
}

describe('the rule, for one parcel', () => {
  it('defaults to twelve hours, and three for the urgent states', () => {
    expect(recheckHours()).toBe(DEFAULT_RECHECK_HOURS);
    expect(recheckHours()).toBe(12);
    expect(urgentRecheckHours()).toBe(DEFAULT_URGENT_RECHECK_HOURS);
    expect(urgentRecheckHours()).toBe(3);
  });

  it('is both variables, so neither is buried in the code', () => {
    process.env.RECHECK_HOURS = '6';
    process.env.URGENT_RECHECK_HOURS = '1';
    expect(recheckHours()).toBe(6);
    expect(urgentRecheckHours()).toBe(1);
  });

  it('refuses a value that would make every parcel permanently due', () => {
    // Zero or negative would be an hourly sweep over everything — the exact
    // thing this change exists to stop — so it falls back rather than quietly
    // costing money.
    for (const bad of ['0', '-5', 'banana', '']) {
      process.env.RECHECK_HOURS = bad;
      expect(recheckHours(), bad).toBe(12);
    }
  });

  const at = new Date(NOW);
  const ago = (hours: number) => new Date(at.getTime() - hours * HOUR);

  it('is not due at eleven hours and is due at thirteen', () => {
    expect(isDue({ state: 'in_transit', lastReconciledAt: ago(11) }, at)).toBe(false);
    expect(isDue({ state: 'in_transit', lastReconciledAt: ago(13) }, at)).toBe(true);
  });

  it('is due at four hours when the parcel is urgent', () => {
    for (const state of URGENT_STATES) {
      expect(isDue({ state, lastReconciledAt: ago(2) }, at), state).toBe(false);
      expect(isDue({ state, lastReconciledAt: ago(4) }, at), state).toBe(true);
    }
  });

  it('counts a parcel out with the postman as urgent', () => {
    // The state a failed delivery comes out of, and the gap between "the van
    // has it" and "nobody was home" is the gap in which a customer can still
    // be told. It was not on the urgent list before this round.
    expect(URGENT_STATES).toContain('out_for_delivery');
    expect(isDue({ state: 'out_for_delivery', lastReconciledAt: ago(4) }, at)).toBe(true);
    expect(isDue({ state: 'in_transit', lastReconciledAt: ago(4) }, at)).toBe(false);
  });

  it('is always due when nobody has ever asked', () => {
    expect(isDue({ state: 'created', lastReconciledAt: null }, at)).toBe(true);
  });

  it('is never due once the parcel is finished', () => {
    for (const state of ['delivered', 'collected', 'returned']) {
      expect(isDue({ state, lastReconciledAt: null }, at), state).toBe(false);
      expect(isDue({ state, lastReconciledAt: ago(500) }, at), state).toBe(false);
    }
  });

  it('is never due once somebody has stopped chasing it', () => {
    expect(isDue({ state: 'at_office', lastReconciledAt: ago(99), droppedAt: at }, at)).toBe(false);
  });
});

describe('the rule, as the queue applies it', () => {
  it('picks the same parcels the one-row rule would', async () => {
    const cases: [string, string, number | null, boolean][] = [
      ['PQ10000001ES', 'in_transit', 11, false],
      ['PQ10000002ES', 'in_transit', 13, true],
      ['PQ10000003ES', 'at_office', 2, false],
      ['PQ10000004ES', 'at_office', 4, true],
      ['PQ10000005ES', 'out_for_delivery', 4, true],
      ['PQ10000006ES', 'created', null, true],
      ['PQ10000007ES', 'delivered', 500, false],
      ['PQ10000008ES', 'collected', null, false],
    ];

    const ids = new Map<string, string>();
    for (const [code, state, hours] of cases) ids.set(code, await parcel(code, state, hours));

    const asked = stub();
    await reconcile({ dueOnly: true });

    for (const [code, , , shouldBe] of cases) {
      expect(asked.includes(code), `${code} due=${shouldBe}`).toBe(shouldBe);
    }
    // And the counts agree with the queue.
    expect(await countDue()).toBe(0); // all the due ones were just stamped
    expect(ids.size).toBe(cases.length);
  });

  it('asks about the urgent ones first, then the longest unchecked', async () => {
    await parcel('PQ11000001ES', 'in_transit', 40);
    await parcel('PQ11000002ES', 'in_transit', 20);
    await parcel('PQ11000003ES', 'at_office', 4);

    const asked = stub();
    await reconcile({ dueOnly: true });

    expect(asked).toEqual(['PQ11000003ES', 'PQ11000001ES', 'PQ11000002ES']);
  });

  it('ends without asking Correos anything when nothing is due', async () => {
    await parcel('PQ12000001ES', 'in_transit', 1);
    await parcel('PQ12000002ES', 'at_office', 1);

    const asked = stub();
    const r = await reconcile({ dueOnly: true });

    expect(asked).toEqual([]);
    expect(r.skipped).toBe(true);
    expect(r.detail.skipped).toBe('nothing was due');
    // And it says what the rule is, so a skipped run is still informative.
    expect(r.detail.live).toBe(2);
    expect(r.detail.recheckHours).toBe(12);
    expect(r.detail.urgentRecheckHours).toBe(3);
  });

  it('still asks about everything when a person presses Refresh', async () => {
    // `dueOnly` is the cron's. Being told "nothing was due" is not an answer
    // to somebody pressing a button.
    await parcel('PQ13000001ES', 'in_transit', 1);
    await parcel('PQ13000002ES', 'at_office', 1);

    const asked = stub();
    const r = await reconcile({ manual: true });

    expect(asked.sort()).toEqual(['PQ13000001ES', 'PQ13000002ES']);
    expect(r.skipped).toBeUndefined();
  });

  it('leaves finished parcels alone even on a manual sweep', async () => {
    await parcel('PQ14000001ES', 'delivered', null);
    await parcel('PQ14000002ES', 'in_transit', null);

    const asked = stub();
    await reconcile({ manual: true });

    expect(asked).toEqual(['PQ14000002ES']);
  });

  it('honours the variables rather than the defaults', async () => {
    process.env.RECHECK_HOURS = '2';
    await parcel('PQ15000001ES', 'in_transit', 3);

    const asked = stub();
    await reconcile({ dueOnly: true });

    // Not due under the twelve-hour default; due under the two-hour setting.
    expect(asked).toEqual(['PQ15000001ES']);
  });
});

describe('overdue, which is not the same as due', () => {
  it('leaves a parcel that only just came due out of it', async () => {
    // Due means "it is time to ask". Overdue means the promise has been
    // broken. A parcel four minutes past its window has not been failed by
    // anything, so the grace is one hour — the gap between cron runs.
    await parcel('PQ16000001ES', 'in_transit', 12.5);
    expect(await countDue()).toBe(1);
    expect(await countOverdue()).toBe(0);
  });

  it('counts one that has gone well past', async () => {
    await parcel('PQ16000002ES', 'in_transit', 20);
    expect(await countOverdue()).toBe(1);
  });

  it('measures a never-asked parcel from when we first knew of it', async () => {
    // A minute after an upload every new parcel is due and none is overdue.
    // Measuring from `last_reconciled_at IS NULL` alone would paint the whole
    // screen red the moment a file was imported.
    await parcel('PQ16000003ES', 'created', null);
    expect(await countDue()).toBe(1);
    expect(await countOverdue()).toBe(0);
  });

  it('counts nothing once every parcel is finished', async () => {
    await parcel('PQ16000004ES', 'delivered', 500);
    expect(await countLive()).toBe(0);
    expect(await countOverdue()).toBe(0);
    expect(await countDue()).toBe(0);
  });
});

describe('what the run records', () => {
  it('reports the events it stored, not only the parcels it asked about', async () => {
    await parcel('PQ17000001ES', 'created', null);

    setTrackpub({
      configured: true,
      mode: 'comma',
      diagnosis: null,
      batchSize: 100,
      adoptMode() { /* fixed */ },
      async lookup() { throw new Error('not used'); },
      async lookupMany(codes: readonly string[]) {
        const byCode = new Map<string, LookupResult>();
        for (const code of codes) {
          byCode.set(code, {
            ok: true,
            raw: {},
            outcome: {
              problems: [], errors: [], codesSeen: [code],
              events: [
                {
                  shippingCode: code, eventCode: 'A090000V', eventDesc: 'Prerregistrado',
                  occurredAt: new Date('2026-10-06T16:07:00+02:00'), source: 'poll' as const,
                  rawPayload: {},
                },
                {
                  shippingCode: code, eventCode: 'A010000V', eventDesc: 'Admitido.',
                  occurredAt: new Date('2026-10-07T20:41:00+02:00'), source: 'poll' as const,
                  rawPayload: {},
                },
              ],
            },
          });
        }
        return {
          byCode, notReached: [], mode: 'comma' as const, requests: 1,
          batchDiagnosis: null, batchSize: 100,
        };
      },
    } as unknown as TrackpubClient);

    const r = await reconcile({ dueOnly: true });

    /*
     * One parcel, two events. `changed` counts parcels and would be 1; the day
     * tracking broke, six runs reported "asked 201, changed 0" and that is
     * also what a quiet night looks like. `newEvents` is what tells the two
     * apart, and it is why the Settings screen can now warn about silence.
     */
    expect(r.detail.asked).toBe(1);
    expect(r.detail.changed).toBe(1);
    expect(r.detail.newEvents).toBe(2);
  });

  it('records the run, so the engine-health banner and the cost line see it', async () => {
    await parcel('PQ18000001ES', 'created', null);
    stub();
    const { runJob } = await import('@/jobs/definitions');
    await runJob('reconcile', () => reconcile({ dueOnly: true }));

    const runs = await getDb().select().from(jobRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].finishedAt).not.toBeNull();
    expect((runs[0].detail as Record<string, unknown>).newEvents).toBe(0);
  });
});
