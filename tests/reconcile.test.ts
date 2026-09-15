import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { and, isNull, notInArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipments } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { reconcile } from '@/jobs/definitions';
import { TrackpubClient, setTrackpub, type LookupResult } from '@/lib/carriers/correos/trackpub';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The reconcile sweep is the only thing that ever repairs an event Correos
 * dropped, because Correos does not retry a push. So the thing that matters is
 * not that it finishes — it may not, once volume grows and the API is rate
 * limited — but that stopping short costs nothing except time.
 */

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-09-01T10:00:00+02:00');
  clock.install();
});

afterEach(() => { setTrackpub(null); });

afterAll(async () => {
  resetClock();
  await closeDb();
});

/** A trackpub that answers instantly and records what it was asked. */
function stubTrackpub(answer: (code: string) => LookupResult, delayMs = 0) {
  const asked: string[] = [];
  const client = {
    configured: true,
    async lookup(code: string): Promise<LookupResult> {
      asked.push(code);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return answer(code);
    },
  } as unknown as TrackpubClient;
  setTrackpub(client);
  return asked;
}

const emptyAnswer = (): LookupResult => ({
  ok: true,
  outcome: { events: [], problems: [] },
  raw: {},
});

async function makeMany(n: number): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const f = await makeShipment({ shippingCode: `PQ90000000${String(i).padStart(2, '0')}ES` });
    codes.push(f.shippingCode);
  }
  return codes;
}

const stillToCheck = async () => {
  const rows = await getDb().select({ last: shipments.lastReconciledAt }).from(shipments)
    .where(and(isNull(shipments.droppedAt), notInArray(shipments.state, ['delivered', 'collected', 'returned'])));
  return rows.filter((r) => r.last === null).length;
};

describe('the reconcile sweep', () => {
  it('does nothing, loudly, when Correos is not configured', async () => {
    setTrackpub(new TrackpubClient({ clientId: '', clientSecret: '', jwt: '' }));
    await makeMany(2);
    const r = await reconcile();
    expect(r.detail.skipped).toBe('Correos credentials are not configured');
  });

  it('checks a bounded batch rather than everything in sight', async () => {
    await makeMany(10);
    const asked = stubTrackpub(emptyAnswer);

    const r = await reconcile({ batchSize: 4 });

    expect(asked).toHaveLength(4);
    expect(r.detail.checked).toBe(4);
    expect(r.detail.stillToCheck).toBe(6);
  });

  it('takes the least-recently-checked first, so nothing is starved', async () => {
    await makeMany(6);
    const first = stubTrackpub(emptyAnswer);
    await reconcile({ batchSize: 3 });
    setTrackpub(null);

    const second = stubTrackpub(emptyAnswer);
    await reconcile({ batchSize: 3 });

    // The second run asked about three different parcels.
    expect(second).toHaveLength(3);
    expect(second.some((c) => first.includes(c))).toBe(false);
    expect(await stillToCheck()).toBe(0);
  });

  it('resumes where it stopped when it runs out of time', async () => {
    await makeMany(8);
    // 30ms per lookup against a 100ms budget: it gets through a few and stops.
    const asked = stubTrackpub(emptyAnswer, 30);

    const first = await reconcile({ batchSize: 8, budgetMs: 100 });
    expect(first.detail.stoppedEarly).toMatch(/ran out of time/);
    expect(asked.length).toBeLessThan(8);
    expect(asked.length).toBeGreaterThan(0);

    const doneFirst = asked.length;
    const remaining = await stillToCheck();
    expect(remaining).toBe(8 - doneFirst);

    // Given time, the next run starts with exactly the ones left over. It may
    // go on to re-check the earlier ones too — that is correct, they are the
    // next-oldest — but the unchecked ones lead.
    setTrackpub(null);
    const second = stubTrackpub(emptyAnswer);
    await reconcile({ batchSize: 8, budgetMs: 60_000 });

    expect(second.slice(0, remaining).some((c) => asked.includes(c))).toBe(false);
    expect(await stillToCheck()).toBe(0);
  });

  it('never marks a parcel checked that it did not manage to check', async () => {
    // Being killed mid-sweep is how a parcel gets a stamp without a lookup,
    // and then goes unchecked for as long as it takes everything else to catch
    // up with it.
    await makeMany(5);
    const asked = stubTrackpub(emptyAnswer, 30);
    await reconcile({ batchSize: 5, budgetMs: 60 });

    const rows = await getDb().select({
      code: shipments.shippingCode, last: shipments.lastReconciledAt,
    }).from(shipments);

    for (const row of rows) {
      const wasAsked = asked.includes(row.code);
      expect(row.last === null).toBe(!wasAsked);
    }
  });

  it('gives up rather than hammering an API that is refusing requests', async () => {
    await makeMany(40);
    const asked = stubTrackpub(() => ({
      ok: false, status: 429, error: 'Too Many Requests', retryable: true,
    }));

    const r = await reconcile({ batchSize: 40, budgetMs: 60_000 });

    expect(r.detail.stoppedEarly).toMatch(/refusing requests/);
    expect(asked.length).toBeLessThanOrEqual(10);
    // And nothing got a stamp, so the next run retries all of them.
    expect(await stillToCheck()).toBe(40);
  });

  it('counts a parcel Correos has never heard of as checked', async () => {
    // Asking again in two hours will not change the answer, and letting it sit
    // at the front of the queue forever would starve everything behind it.
    await makeMany(2);
    stubTrackpub(() => ({ ok: false, status: 404, error: 'unknown', retryable: false }));

    await reconcile({ batchSize: 2 });
    expect(await stillToCheck()).toBe(0);
  });

  it('recovers an event that push never delivered', async () => {
    const f = await makeShipment();
    stubTrackpub(() => ({
      ok: true,
      raw: {},
      outcome: {
        problems: [],
        events: [{
          shippingCode: f.shippingCode,
          eventCode: 'E-05',
          eventDesc: 'Disponible en oficina para recoger',
          occurredAt: clock.now(),
          source: 'poll',
          officeCode: f.officeCode,
          officeName: 'Oficina Madrid Sucursal 12',
          rawPayload: {},
        }],
      },
    }));

    const r = await reconcile({ batchSize: 10 });
    expect(r.detail.recovered).toBe(1);

    const [row] = await getDb().select().from(shipments);
    expect(row.state).toBe('at_office');
    expect(row.officeDeadline).not.toBeNull();
  });

  it('re-reading the same events recovers nothing the second time', async () => {
    const f = await makeShipment();
    const answer = (): LookupResult => ({
      ok: true,
      raw: {},
      outcome: {
        problems: [],
        events: [{
          shippingCode: f.shippingCode,
          eventCode: 'E-05',
          eventDesc: 'Disponible en oficina para recoger',
          occurredAt: new Date('2026-09-01T09:00:00+02:00'),
          source: 'poll',
          officeCode: f.officeCode,
          rawPayload: {},
        }],
      },
    });

    stubTrackpub(answer);
    expect((await reconcile({ batchSize: 10 })).detail.recovered).toBe(1);
    expect((await reconcile({ batchSize: 10 })).detail.recovered).toBe(0);
  });
});
