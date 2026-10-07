import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, getSql } from '@/db';
import { activity, alerts, escalationExtras, notifications, tasks } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runTick, runShipment } from '@/lib/escalation/run';
import { liveShipmentIds } from '@/lib/shipments/repo';
import { setSetting } from '@/lib/settings';
import { openTask } from '@/lib/escalation/tasks';
import { markFired, scheduleExtra } from '@/lib/escalation/silence';
import { raiseAlert } from '@/lib/alerts';
import { say } from '@/lib/activity';
import { acquireJobLock, releaseJobLock } from '@/lib/job-lock';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * Vercel Cron is best-effort: it does not retry, it can fire the same run
 * twice, and two runs can overlap. The lock makes that rare; these tests are
 * about what happens when it does anyway.
 *
 * Two concurrent ticks must not send the customer two identical WhatsApps, nor
 * put the same job on the call list twice, nor email the team twice about one
 * return. Every one of those is enforced in the database, so it holds even if
 * the lock is bypassed entirely — which it is here, deliberately.
 */

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-01T10:00:00+02:00');
  clock.install();
  await setSetting('phase', 2);
  // Open the pool before racing. postgres.js connects lazily, so the first
  // query of a Promise.all would otherwise serialise behind the handshake and
  // the "concurrent" runs would not overlap at all.
  await getSql()`SELECT 1`;
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

const atOffice = async () => {
  const f = await makeShipment({ depositDays: 15, paymentMethod: 'cod', valueCents: 14850 });
  await ingestEvent({
    shippingCode: f.shippingCode,
    eventCode: 'E-05',
    eventDesc: 'Disponible en oficina para recoger',
    occurredAt: clock.now(),
    source: 'push',
    officeCode: f.officeCode,
    officeName: 'Oficina Madrid Sucursal 12',
    rawPayload: {},
  });
  return f;
};

const countOf = async (table: string, shipmentId: string) => {
  const rows = await getSql().unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE shipment_id = $1`, [shipmentId],
  );
  return (rows[0] as unknown as { n: number }).n;
};

describe('two escalation ticks at the same time', () => {
  it('writes one message, not two', async () => {
    const f = await atOffice();

    await Promise.all([
      runShipment(f.shipmentId, clock.now()),
      runShipment(f.shipmentId, clock.now()),
    ]);

    const rows = await getDb().select().from(notifications)
      .where(eq(notifications.shipmentId, f.shipmentId));

    expect(rows).toHaveLength(1);
    expect(rows[0].template).toBe('office_details');
  });

  it('writes one message even when the whole tick is run twice at once', async () => {
    const f = await atOffice();
    const ids = await liveShipmentIds();

    await Promise.all([runTick(ids, clock.now()), runTick(ids, clock.now())]);

    expect(await countOf('notifications', f.shipmentId)).toBe(1);
  });

  it('opens one task, and announces it once', async () => {
    const f = await atOffice();
    // Two days left: the rung that books a call nobody may skip.
    clock.set('2026-10-14T10:00:00+02:00');

    await Promise.all([
      runShipment(f.shipmentId, clock.now()),
      runShipment(f.shipmentId, clock.now()),
    ]);

    const open = await getDb().select().from(tasks)
      .where(and(eq(tasks.shipmentId, f.shipmentId), eq(tasks.status, 'open')));
    expect(open.filter((t) => t.type === 'call')).toHaveLength(1);

    const lines = await getDb().select().from(activity)
      .where(eq(activity.shipmentId, f.shipmentId));
    const lastWarning = lines.filter((l) => l.text.includes('a call you cannot skip'));
    expect(lastWarning).toHaveLength(1);
  });

  it('raises one alert when Correos says it is coming back, not two', async () => {
    const f = await atOffice();
    clock.set('2026-10-17T10:00:00+02:00');

    /*
     * This used to be about the deposit window running out, which the engine
     * worked out itself from a guessed fifteen days. That rung is gone: the
     * return is Correos' to announce, and when they do, the alert comes from
     * `notifyReturnStarted` instead. The concurrency question is the same —
     * two ticks, one alert — so the test now asks it of the event that really
     * raises one.
     */
    await Promise.all([
      ingestEvent({
        shippingCode: f.shippingCode, eventCode: 'L03D320R',
        eventDesc: 'Finalizado plazo retirada',
        occurredAt: clock.now(), source: 'poll', rawPayload: {},
      }),
      runShipment(f.shipmentId, clock.now()),
      runShipment(f.shipmentId, clock.now()),
    ]);

    const raised = await getDb().select().from(alerts).where(eq(alerts.shipmentId, f.shipmentId));
    expect(raised).toHaveLength(1);
    expect(raised[0].subject).toContain('Coming back');
  });

  it('runs the whole office ladder twice over and still sends each message once', async () => {
    const f = await atOffice();
    clock.set('2026-10-16T10:00:00+02:00');

    await Promise.all([
      runShipment(f.shipmentId, clock.now()),
      runShipment(f.shipmentId, clock.now()),
      runShipment(f.shipmentId, clock.now()),
    ]);

    const rows = await getDb().select().from(notifications)
      .where(eq(notifications.shipmentId, f.shipmentId));
    const templates = rows.map((r) => r.template).sort();

    expect(new Set(templates).size).toBe(templates.length);
  });
});

/**
 * The same guarantees, proved deterministically. A Promise.all gives
 * concurrency but not a chosen interleaving — two runs can serialise on a fast
 * machine and the test above would pass with every constraint dropped. These
 * do the two writes in sequence, which is what actually proves the index.
 */
describe('the second write, deterministically', () => {
  it('a rung can only be claimed once', async () => {
    const f = await atOffice();
    expect(await markFired(f.shipmentId, 'o15')).toBe(true);
    expect(await markFired(f.shipmentId, 'o15')).toBe(false);
  });

  it('a message keyed to the same firing cannot be written twice', async () => {
    const f = await atOffice();
    const dueAt = new Date('2026-10-01T10:00:00+02:00');

    const insert = () => getDb().insert(notifications).values({
      shipmentId: f.shipmentId,
      template: 'office_details',
      body: 'hola',
      channel: 'whatsapp',
      status: 'queued',
      rungId: 'o15',
      rungDueAt: dueAt,
    }).onConflictDoNothing({
      target: [notifications.shipmentId, notifications.rungId, notifications.rungDueAt],
    }).returning({ id: notifications.id });

    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
  });

  it('but the SAME rung due at a NEW moment is a new message', async () => {
    // A parcel can legitimately fail delivery twice. The ingest path clears the
    // fires rows on the second failure, so the first-contact message is
    // correctly due again — and a key without the due moment would silently
    // swallow it.
    const f = await atOffice();

    const insert = (due: string) => getDb().insert(notifications).values({
      shipmentId: f.shipmentId,
      template: 'failed_first',
      body: 'hola',
      channel: 'whatsapp',
      status: 'queued',
      rungId: 'f15',
      rungDueAt: new Date(due),
    }).onConflictDoNothing({
      target: [notifications.shipmentId, notifications.rungId, notifications.rungDueAt],
    }).returning({ id: notifications.id });

    expect(await insert('2026-10-01T10:00:00Z')).toHaveLength(1);
    expect(await insert('2026-10-08T10:00:00Z')).toHaveLength(1);
  });

  it('an operator-written message needs no rung at all', async () => {
    // Both columns null together. The CHECK enforces the pairing, because a
    // unique index treats nulls as distinct and one stray null would switch the
    // whole guarantee off with no error.
    const f = await atOffice();
    const rows = await getDb().insert(notifications).values({
      shipmentId: f.shipmentId, template: 'office_details', body: 'by hand',
      channel: 'whatsapp', status: 'queued',
    }).returning({ id: notifications.id });
    expect(rows).toHaveLength(1);
  });

  it('refuses a half-set rung key rather than silently disabling the index', async () => {
    const f = await atOffice();
    await expect(getSql()`
      INSERT INTO notifications (shipment_id, template, body, channel, status, rung_id)
      VALUES (${f.shipmentId}, 'office_details', 'x', 'whatsapp', 'queued', 'o15')
    `).rejects.toThrow(/notifications_rung_paired/);
  });

  it('keeps one follow-up of each kind in flight, whatever the rung id says', async () => {
    const f = await atOffice();
    await scheduleExtra(f.shipmentId, 'retry', new Date('2026-10-02T10:00:00Z'));
    await scheduleExtra(f.shipmentId, 'retry', new Date('2026-10-02T10:00:00.001Z'));

    const rows = await getDb().select().from(escalationExtras)
      .where(eq(escalationExtras.shipmentId, f.shipmentId));
    expect(rows.filter((r) => r.kind === 'retry')).toHaveLength(1);
    // The newest booking wins, rather than the first one sticking.
    expect(rows.find((r) => r.kind === 'retry')?.dueAt.toISOString()).toBe('2026-10-02T10:00:00.001Z');
  });

  it('counts only one of three concurrent task openings as new', async () => {
    const f = await atOffice();
    const results = await Promise.all([
      openTask({ shipmentId: f.shipmentId, type: 'call', reason: 'a', label: 'A' }),
      openTask({ shipmentId: f.shipmentId, type: 'call', reason: 'b', label: 'B' }),
      openTask({ shipmentId: f.shipmentId, type: 'call', reason: 'c', label: 'C' }),
    ]);

    expect(results.filter((r) => r === 'opened')).toHaveLength(1);
    expect(await countOf('tasks', f.shipmentId)).toBe(1);
  });

  it('raises an alert once per dedupe key', async () => {
    expect(await raiseAlert({ dedupeKey: 'k', subject: 's', lines: ['a'] })).toBe(true);
    expect(await raiseAlert({ dedupeKey: 'k', subject: 's', lines: ['a'] })).toBe(false);
    expect(await getDb().select().from(alerts)).toHaveLength(1);
  });

  it('narrates a keyed line once and an unkeyed line as often as it happens', async () => {
    await say('the same thing', { dedupeKey: 'once' });
    await say('the same thing', { dedupeKey: 'once' });
    await say('a repeatable thing');
    await say('a repeatable thing');

    const rows = await getDb().select().from(activity);
    expect(rows.filter((r) => r.text === 'the same thing')).toHaveLength(1);
    expect(rows.filter((r) => r.text === 'a repeatable thing')).toHaveLength(2);
  });
});

describe('the job lock', () => {
  it('lets exactly one of several simultaneous runs through', async () => {
    const results = await Promise.all([
      acquireJobLock('escalation-tick', 60),
      acquireJobLock('escalation-tick', 60),
      acquireJobLock('escalation-tick', 60),
      acquireJobLock('escalation-tick', 60),
    ]);
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });

  it('creates its own row — nothing is seeded, so nothing can be missing', async () => {
    // Seeding rows in the migration would be worse than this: the test helper
    // truncates every table, so they would vanish and every job would look
    // permanently locked; and a job added later without a seed row would never
    // run again.
    const r = await acquireJobLock('postcode-stats', 60);
    expect(r.acquired).toBe(true);
  });

  it('says until when, when it refuses', async () => {
    await acquireJobLock('daily-digest', 60);
    const second = await acquireJobLock('daily-digest', 60);

    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.heldUntil).toBeInstanceOf(Date);
  });

  it('does not block a different job', async () => {
    await acquireJobLock('escalation-tick', 60);
    expect((await acquireJobLock('reconcile', 60)).acquired).toBe(true);
  });

  it('frees the lock on release, so a quick job does not block the next tick', async () => {
    const first = await acquireJobLock('housekeeping', 600);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    await releaseJobLock(first.lease);
    expect((await acquireJobLock('housekeeping', 60)).acquired).toBe(true);
  });

  it('ignores a release from an instance whose lease has already moved on', async () => {
    // Serverless freezes instances. One that wakes up after its lease expired
    // must not free a lock a later run legitimately holds — that would
    // re-create the double-run the lock exists to prevent.
    const first = await acquireJobLock('stale-detector', 60);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    await releaseJobLock({ job: 'stale-detector', token: 'a-token-from-a-frozen-instance' });

    expect((await acquireJobLock('stale-detector', 60)).acquired).toBe(false);
  });

  it('treats an expired lease as free', async () => {
    await acquireJobLock('import-reminder', 60);
    await getSql()`UPDATE job_locks SET locked_until = now() - interval '1 second' WHERE job = 'import-reminder'`;
    expect((await acquireJobLock('import-reminder', 60)).acquired).toBe(true);
  });

  it('computes the lease from the database clock, not the app clock', async () => {
    // Demo mode can move the app clock by a fortnight. A lease computed from it
    // would land a fortnight out and the job would be unrunnable until somebody
    // edited the row by hand.
    clock.set('2027-01-01T00:00:00Z');

    const r = await acquireJobLock('push-drain', 60);
    expect(r.acquired).toBe(true);

    const rows = await getSql()`SELECT locked_until FROM job_locks WHERE job = 'push-drain'`;
    const until = new Date((rows[0] as { locked_until: string }).locked_until).getTime();
    // Within a couple of minutes of real now, not of the clock the test set.
    expect(Math.abs(until - Date.now())).toBeLessThan(120_000);
  });
});
