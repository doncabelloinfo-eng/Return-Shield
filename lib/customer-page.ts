import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { notifications, offices, orders, shipments, stores } from '@/db/schema';
import { verifyActionToken } from '@/lib/action-token';
import { SAVED_STATES, type ShipmentState } from '@/lib/state-machine/states';
import { now } from '@/lib/clock';
import { daysLeft } from '@/lib/time';

/**
 * Everything behind a /e/{token} link, and the rules about when it stops
 * working: on delivery, and after thirty days. A link that outlives the parcel
 * is a link that tells a stranger where somebody's post office is.
 */

export type TokenRejection = 'invalid' | 'expired' | 'finished' | 'unknown';

export interface CustomerView {
  shipmentId: string;
  notificationId: string;
  storeName: string;
  orderNumber: string;
  shippingCode: string;
  state: ShipmentState;
  stateEs: string;
  officeName: string | null;
  officeAddress: string | null;
  officeHours: string | null;
  daysLeft: number | null;
  firstName: string;
}

/** What we tell the customer their parcel is doing, in their own language. */
const STATE_ES: Partial<Record<ShipmentState, string>> = {
  failed: 'No pudimos entregarlo',
  at_office: 'Te espera en la oficina de Correos',
  returning: 'Vuelve a origen',
  returned: 'Ha vuelto a origen',
  bad_address: 'La dirección no es correcta',
  delivered: 'Entregado',
  collected: 'Recogido',
  refused: 'Rechazado',
};

export async function resolveToken(token: string): Promise<
  { ok: true; view: CustomerView } | { ok: false; why: TokenRejection }
> {
  const verified = verifyActionToken(token);
  if (!verified) return { ok: false, why: 'invalid' };

  const [row] = await db.select({
    notificationId: notifications.id,
    tokenExpiresAt: notifications.tokenExpiresAt,
    shipmentId: shipments.id,
    state: shipments.state,
    shippingCode: shipments.shippingCode,
    officeDeadline: shipments.officeDeadline,
    orderNumber: orders.orderNumber,
    customerName: orders.customerName,
    storeName: stores.name,
    officeName: offices.name,
    officeAddress: offices.address,
    officeHours: offices.openingHours,
  })
    .from(notifications)
    .innerJoin(shipments, eq(shipments.id, notifications.shipmentId))
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .leftJoin(offices, eq(offices.id, shipments.officeId))
    .where(eq(notifications.actionToken, token))
    .limit(1);

  if (!row) return { ok: false, why: 'unknown' };
  if (row.tokenExpiresAt && row.tokenExpiresAt < now()) return { ok: false, why: 'expired' };

  const state = row.state as ShipmentState;
  // The link dies the moment the parcel is in the customer's hands.
  if (SAVED_STATES.has(state)) return { ok: false, why: 'finished' };

  return {
    ok: true,
    view: {
      shipmentId: row.shipmentId,
      notificationId: row.notificationId,
      storeName: row.storeName,
      orderNumber: row.orderNumber,
      shippingCode: row.shippingCode,
      state,
      stateEs: STATE_ES[state] ?? 'En curso',
      officeName: row.officeName,
      officeAddress: row.officeAddress,
      officeHours: row.officeHours,
      daysLeft: daysLeft(row.officeDeadline),
      firstName: row.customerName.trim().split(/\s+/)[0] ?? '',
    },
  };
}

/** Opening the link is itself a signal: they read the message. */
export async function markLinkOpened(notificationId: string): Promise<void> {
  await db.update(notifications)
    .set({ linkOpenedAt: now() })
    .where(and(eq(notifications.id, notificationId), isNull(notifications.linkOpenedAt)));
}
