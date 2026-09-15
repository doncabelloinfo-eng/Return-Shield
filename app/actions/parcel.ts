'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/guard';
import {
  askCorreos, confirmAddress, dropIt, isCallOutcome, logCall,
  restock, sendRedirect, undoDrop, undoRestock,
} from '@/lib/escalation/outcomes';
import { getDb } from '@/db';
import { notifications } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { now } from '@/lib/clock';

/**
 * Everything a button on a screen can do.
 *
 * Each one checks the session first — a server action is a public endpoint
 * whatever the page around it looks like — and each one revalidates the whole
 * panel, because one decision usually changes several screens at once: filing
 * a call empties a row from Today, from the call list and from the parcel page.
 */

function refresh(): void {
  revalidatePath('/', 'layout');
}

export async function fileCallOutcome(shipmentId: string, outcome: string, note: string) {
  const user = await requireUser();
  if (!isCallOutcome(outcome)) throw new Error(`unknown call outcome: ${outcome}`);
  const r = await logCall(shipmentId, outcome, note ?? '', user.id);
  refresh();
  return r;
}

export async function restockParcel(shipmentId: string) {
  const user = await requireUser();
  const r = await restock(shipmentId, user.id);
  refresh();
  return r;
}

export async function restockMany(shipmentIds: string[]) {
  const user = await requireUser();
  for (const id of shipmentIds) await restock(id, user.id);
  refresh();
  return { toast: `${shipmentIds.length} parcels back in stock.` };
}

export async function undoRestockParcel(shipmentId: string) {
  await requireUser();
  await undoRestock(shipmentId);
  refresh();
}

/** Correos charges for a redirection. Always behind a second tap. */
export async function sendNewAddress(shipmentId: string) {
  const user = await requireUser();
  const r = await sendRedirect(shipmentId, user.id);
  refresh();
  return r;
}

/** Writes the parcel off. Always behind a second tap, and undoable. */
export async function stopChasing(shipmentId: string) {
  const user = await requireUser();
  const r = await dropIt(shipmentId, user.id);
  refresh();
  return r;
}

export async function undoStopChasing(shipmentId: string) {
  await requireUser();
  await undoDrop(shipmentId);
  refresh();
}

export async function askCorreosAbout(shipmentId: string) {
  const user = await requireUser();
  const r = await askCorreos(shipmentId, user.id);
  refresh();
  return r;
}

export async function confirmAddressNow(shipmentId: string) {
  const user = await requireUser();
  const r = await confirmAddress(shipmentId, user.id);
  refresh();
  return r;
}

/**
 * Step 1: the operator copied the message and sent it themselves. Recording it
 * is what stops the parcel looking un-contacted on tomorrow's list.
 */
export async function markMessageCopied(notificationId: string) {
  await requireUser();
  await getDb().update(notifications)
    .set({ status: 'copied', sentAt: now() })
    .where(eq(notifications.id, notificationId));
  refresh();
}
