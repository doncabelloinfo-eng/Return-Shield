import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { notifications, orders, shipmentEvents, shipments, stores } from '@/db/schema';
import { STATE_LABEL } from '@/lib/carriers/correos/state-map';
import { fmt, exact } from '@/lib/time';
import { DockTabs } from './DockTabs';

/**
 * The right-hand column: what the customer actually received, and everything
 * Correos has said, newest first.
 *
 * Both are real. The phone is not a mock-up of a message we might send — it is
 * the messages this system wrote, in the order it wrote them, so "did they
 * ever hear from us?" is answered by looking rather than by asking.
 */
export async function Dock() {
  const [messages, feed] = await Promise.all([
    getDb().select({
      id: notifications.id,
      body: notifications.body,
      linkLabel: notifications.linkLabel,
      status: notifications.status,
      createdAt: notifications.createdAt,
      customerName: orders.customerName,
      storeName: stores.name,
      shipmentId: notifications.shipmentId,
    })
      .from(notifications)
      .innerJoin(shipments, eq(shipments.id, notifications.shipmentId))
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .innerJoin(stores, eq(stores.id, orders.storeId))
      .orderBy(desc(notifications.createdAt))
      .limit(40),

    getDb().select({
      id: shipmentEvents.id,
      desc: shipmentEvents.eventDesc,
      mappedState: shipmentEvents.mappedState,
      occurredAt: shipmentEvents.occurredAt,
      source: shipmentEvents.source,
      customerName: orders.customerName,
      orderNumber: orders.orderNumber,
      shipmentId: shipmentEvents.shipmentId,
    })
      .from(shipmentEvents)
      .innerJoin(shipments, eq(shipments.id, shipmentEvents.shipmentId))
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .orderBy(desc(shipmentEvents.occurredAt))
      .limit(60),
  ]);

  return (
    <DockTabs
      messages={messages.map((m) => ({
        id: m.id,
        shipmentId: m.shipmentId,
        body: m.body,
        linkLabel: m.linkLabel,
        status: m.status,
        time: fmt(m.createdAt).time,
        customerName: m.customerName,
        storeName: m.storeName,
      }))}
      feed={feed.map((e) => ({
        id: e.id,
        shipmentId: e.shipmentId,
        desc: e.desc,
        state: e.mappedState ? (STATE_LABEL[e.mappedState] ?? e.mappedState) : 'Not seen before',
        known: e.mappedState !== null,
        source: e.source === 'poll' ? 'Nightly check' : 'Live from Correos',
        when: `${fmt(e.occurredAt).date} ${fmt(e.occurredAt).time}`,
        exact: exact(e.occurredAt),
        who: `${e.customerName} · ${e.orderNumber}`,
      }))}
    />
  );
}
