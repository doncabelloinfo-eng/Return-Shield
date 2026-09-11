import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { db } from '@/db';
import {
  escalationExtras, escalationFires, offices, orders, productRules,
  shipmentEvents, shipments, tasks,
} from '@/db/schema';
import { project, type ProjectableEvent, type Projection } from '@/lib/state-machine/project';
import type { ShipmentState } from '@/lib/state-machine/states';
import type { LadderInput, ExtraKind } from '@/lib/escalation/ladder';
import { getSetting } from '@/lib/settings';

/**
 * Reading and rebuilding a shipment. Everything derived lives in one place so
 * there is exactly one answer to "what state is this parcel in".
 */

/** How long the office holds this product. Never falls back to 15 silently. */
export async function depositDaysFor(productCode: string): Promise<number> {
  const [rule] = await db.select().from(productRules)
    .where(eq(productRules.productCode, productCode)).limit(1);

  if (rule) return rule.depositDays;

  // An unknown product code is a configuration gap, not a reason to guess. We
  // create the rule with the working assumption and flag it as unconfirmed so
  // it shows up on the Settings screen asking to be checked with Correos.
  const [fallback] = await db.select().from(productRules)
    .where(eq(productRules.productCode, '*')).limit(1);
  const days = fallback?.depositDays ?? 15;

  await db.insert(productRules)
    .values({ productCode, depositDays: days, label: 'Added automatically — never confirmed with Correos', confirmedWithCarrier: false })
    .onConflictDoNothing();

  return days;
}

export async function eventsFor(shipmentId: string): Promise<ProjectableEvent[]> {
  const rows = await db.select({
    eventCode: shipmentEvents.eventCode,
    eventDesc: shipmentEvents.eventDesc,
    occurredAt: shipmentEvents.occurredAt,
    mappedState: shipmentEvents.mappedState,
    officeCode: shipmentEvents.officeCode,
    officeName: shipmentEvents.officeName,
  }).from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipmentId));

  return rows.map((r) => ({ ...r, mappedState: r.mappedState as ShipmentState | null }));
}

/**
 * Recompute the shipments row from its events and write it back.
 *
 * This is the only function allowed to set `state`, `office_deadline` and
 * friends. Everything else reads them. That is what makes "fix the normaliser
 * and replay" a real option rather than a hope.
 */
export async function reproject(shipmentId: string): Promise<Projection> {
  const [ship] = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
  if (!ship) throw new Error(`reproject: no shipment ${shipmentId}`);

  const depositDays = await depositDaysFor(ship.productCode);
  const p = project(await eventsFor(shipmentId), { depositDays });

  let officeId = ship.officeId;
  if (p.officeCode) {
    const [office] = await db.select({ id: offices.id }).from(offices)
      .where(eq(offices.correosCode, p.officeCode)).limit(1);
    if (office) officeId = office.id;
  }

  await db.update(shipments).set({
    state: p.state,
    stateSince: p.stateSince,
    officeArrivedAt: p.officeArrivedAt,
    officeDeadline: p.officeDeadline,
    failedAt: p.failedAt,
    lastEventAt: p.lastEventAt,
    officeId,
  }).where(eq(shipments.id, shipmentId));

  return p;
}

/** Rebuild every shipment. Used after a normaliser fix. */
export async function reprojectAll(): Promise<number> {
  const rows = await db.select({ id: shipments.id }).from(shipments);
  for (const r of rows) await reproject(r.id);
  return rows.length;
}

/** Deposit days changed: every live deadline is now a different day. */
export async function recalculateDeadlines(productCode?: string): Promise<number> {
  const rows = await db.select({ id: shipments.id }).from(shipments).where(
    productCode
      ? and(eq(shipments.productCode, productCode), isNull(shipments.droppedAt))
      : isNull(shipments.droppedAt),
  );
  for (const r of rows) await reproject(r.id);
  return rows.length;
}

/* -------------------------------------------------------------------------- */

export async function ladderInput(shipmentId: string): Promise<LadderInput> {
  const [ship] = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
  if (!ship) throw new Error(`ladderInput: no shipment ${shipmentId}`);

  const [fires, extras, staleAfterHours] = await Promise.all([
    db.select({ rungId: escalationFires.rungId }).from(escalationFires)
      .where(eq(escalationFires.shipmentId, shipmentId)),
    db.select().from(escalationExtras).where(eq(escalationExtras.shipmentId, shipmentId)),
    getSetting('staleAfterHours'),
  ]);

  return {
    state: ship.state as ShipmentState,
    failedAt: ship.failedAt,
    officeArrivedAt: ship.officeArrivedAt,
    officeDeadline: ship.officeDeadline,
    lastEventAt: ship.lastEventAt,
    fired: new Set(fires.map((f) => f.rungId)),
    extras: extras.map((e) => ({ rungId: e.rungId, kind: e.kind as ExtraKind, dueAt: e.dueAt })),
    dropped: ship.droppedAt !== null,
    mutedUntil: ship.mutedUntil,
    reacted: ship.reacted,
    staleAfterHours,
  };
}

/** Shipments the engine still has work to do on. */
export async function liveShipmentIds(): Promise<string[]> {
  const rows = await db.select({ id: shipments.id }).from(shipments).where(and(
    isNull(shipments.droppedAt),
    notInArray(shipments.state, ['delivered', 'collected', 'returned']),
  ));
  return rows.map((r) => r.id);
}

/** Everything a screen needs about one parcel, in one query. */
export async function shipmentDetail(shipmentId: string) {
  const [row] = await db.select({
    shipment: shipments,
    order: orders,
    office: offices,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  return row ?? null;
}

export async function openTaskRows(shipmentIds: readonly string[]) {
  if (!shipmentIds.length) return [];
  return db.select().from(tasks).where(and(
    inArray(tasks.shipmentId, shipmentIds as string[]),
    eq(tasks.status, 'open'),
  ));
}
