import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { notifications, shipments, tasks } from '@/db/schema';
import { TestClock, resetClock, DAY } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runShipment } from '@/lib/escalation/run';
import { setSetting } from '@/lib/settings';
import { resolveToken } from '@/lib/customer-page';
import { applyCustomerAction } from '@/lib/escalation/outcomes';
import { mintActionToken } from '@/lib/action-token';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * The /e/{token} page is deliberately public. The token is the credential, so
 * the rules about when it stops working are the security model.
 */

let clock: TestClock;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-09-01T10:00:00+02:00');
  clock.install();
  await setSetting('phase', 2);
});

afterAll(async () => {
  resetClock();
  await closeDb();
});

async function parcelWithToken() {
  const f = await makeShipment();
  await ingestEvent({
    shippingCode: f.shippingCode, eventCode: 'E-05', eventDesc: 'Disponible en oficina para recoger',
    occurredAt: clock.now(), source: 'push', officeCode: f.officeCode, rawPayload: {},
  });
  await runShipment(f.shipmentId, clock.now());

  const [n] = await getDb().select().from(notifications).where(eq(notifications.shipmentId, f.shipmentId));
  return { ...f, token: n.actionToken!, notificationId: n.id };
}

const openTasks = (id: string) =>
  getDb().select().from(tasks).where(and(eq(tasks.shipmentId, id), eq(tasks.status, 'open')));

describe('a customer opening their link', () => {
  it('sees their own parcel, in Spanish', async () => {
    const p = await parcelWithToken();
    const r = await resolveToken(p.token);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.stateEs).toBe('Te espera en la oficina de Correos');
    expect(r.view.officeName).toBe('Oficina Madrid Sucursal 12');
    expect(r.view.daysLeft).toBe(15);
    expect(r.view.firstName).toBe('Lucía');
  });

  it('is turned away with a token that was not signed by us', async () => {
    const p = await parcelWithToken();
    const [id, nonce] = p.token.split('.');
    const forged = `${id}.${nonce}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect((await resolveToken(forged)).ok).toBe(false);
  });

  it('is turned away with a token we signed but never issued', async () => {
    // A correct signature is not enough: the notification has to exist.
    const p = await parcelWithToken();
    const minted = mintActionToken(p.shipmentId);
    const r = await resolveToken(minted);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe('unknown');
  });

  it('stops working once the parcel is delivered', async () => {
    const p = await parcelWithToken();
    await ingestEvent({
      shippingCode: p.shippingCode, eventCode: 'E-06', eventDesc: 'Entregado en oficina',
      occurredAt: clock.advanceDays(1), source: 'push', rawPayload: {},
    });

    const r = await resolveToken(p.token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe('finished');
  });

  it('stops working after thirty days', async () => {
    const p = await parcelWithToken();
    await getDb().update(notifications)
      .set({ tokenExpiresAt: new Date(clock.now().getTime() - DAY) })
      .where(eq(notifications.id, p.notificationId));

    const r = await resolveToken(p.token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe('expired');
  });

  it('gets a different token in every message, so one leak is not all of them', async () => {
    const p = await parcelWithToken();
    clock.advanceDays(3);
    await runShipment(p.shipmentId, clock.now());

    const all = await getDb().select().from(notifications).where(eq(notifications.shipmentId, p.shipmentId));
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all.map((n) => n.actionToken)).size).toBe(all.length);
  });
});

describe('a customer tapping one of the four options', () => {
  it('stops the countdown messages immediately', async () => {
    const p = await parcelWithToken();
    const before = (await getDb().select().from(notifications)
      .where(eq(notifications.shipmentId, p.shipmentId))).length;

    await applyCustomerAction(p.shipmentId, 'ok_address');

    clock.advanceDays(10);
    await runShipment(p.shipmentId, clock.now());

    const after = (await getDb().select().from(notifications)
      .where(eq(notifications.shipmentId, p.shipmentId))).length;
    expect(after).toBe(before);
  });

  it('leaves exactly one thing on an operator list', async () => {
    const p = await parcelWithToken();
    await applyCustomerAction(p.shipmentId, 'change_address');

    const open = await openTasks(p.shipmentId);
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe('address_fix');
    expect(open[0].label).toBe('Send new address to Correos');
  });

  it('"llamadme" puts them on the call list rather than sending more messages', async () => {
    const p = await parcelWithToken();
    await applyCustomerAction(p.shipmentId, 'call_me');

    const open = await openTasks(p.shipmentId);
    expect(open.map((t) => t.type)).toEqual(['call']);
    expect(open[0].label).toBe('Asked us to call them back');
  });

  it('keeps the last warning armed — a tap is not a collection', async () => {
    const p = await parcelWithToken();
    await applyCustomerAction(p.shipmentId, 'ok_address');

    clock.advanceDays(13);
    await runShipment(p.shipmentId, clock.now());

    const templates = (await getDb().select().from(notifications)
      .where(eq(notifications.shipmentId, p.shipmentId))).map((n) => n.template);
    expect(templates).toContain('office_last_call');
  });

  it('records that they answered', async () => {
    const p = await parcelWithToken();
    await applyCustomerAction(p.shipmentId, 'cant_go');

    const [ship] = await getDb().select().from(shipments).where(eq(shipments.id, p.shipmentId));
    expect(ship.reacted).toBe(true);
    expect(ship.redirectPending).toBe(true);
  });
});
