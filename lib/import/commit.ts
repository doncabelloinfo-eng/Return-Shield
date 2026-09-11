import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { importBatches, orders, shipments, stores } from '@/db/schema';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';
import { normalisePhone } from './phone';
import type { PreviewRow } from './parse';

/**
 * Writing an import. Nothing reaches the database until an operator has looked
 * at the preview and pressed the button — which is the whole reason the parser
 * can afford to be forgiving.
 */

export interface CommitResult {
  batchId: string;
  created: number;
  skipped: number;
  fixed: number;
}

export async function commitImport(params: {
  storeKey: string;
  filename: string;
  userId: string;
  rows: PreviewRow[];
  /** Numbers a person typed into the preview, by row number. */
  fixes: Record<number, string>;
}): Promise<CommitResult> {
  const [store] = await db.select().from(stores).where(eq(stores.key, params.storeKey)).limit(1);
  if (!store) throw new Error(`import: no store with key "${params.storeKey}"`);

  const at = now();
  let created = 0;
  let skipped = 0;
  let fixed = 0;
  const errors: { row: number; customer: string; problem: string }[] = [];

  const [batch] = await db.insert(importBatches).values({
    storeId: store.id,
    filename: params.filename,
    uploadedBy: params.userId,
    rowsTotal: params.rows.length,
    createdAt: at,
  }).returning({ id: importBatches.id });

  for (const row of params.rows) {
    if (row.status === 'duplicate') { skipped += 1; continue; }

    // A number typed into the preview replaces whatever was in the file.
    const typed = params.fixes[row.n]?.trim();
    const phone = typed ? normalisePhone(typed) : row.phone;

    if (!row.shippingCode) {
      skipped += 1;
      errors.push({ row: row.n, customer: row.customerName, problem: 'No tracking code' });
      continue;
    }

    if (row.phone.fixes.length || typed) fixed += 1;

    const [order] = await db.insert(orders).values({
      storeId: store.id,
      externalOrderId: row.orderId || row.shippingCode,
      orderNumber: row.orderId || row.shippingCode,
      customerName: row.customerName || 'Unknown customer',
      phoneE164: phone.e164,
      phoneRaw: phone.raw,
      phoneStatus: phone.status,
      email: row.email,
      addressLine: row.address,
      city: row.city,
      postalCode: row.postalCode,
      totalValueCents: row.valueCents,
      paymentMethod: row.paymentMethod,
      placedAt: row.shippedAt ?? at,
      createdAt: at,
    }).onConflictDoUpdate({
      target: [orders.storeId, orders.externalOrderId],
      set: { phoneE164: phone.e164, phoneStatus: phone.status, phoneRaw: phone.raw },
    }).returning({ id: orders.id });

    const [ship] = await db.insert(shipments).values({
      orderId: order.id,
      carrier: 'correos',
      shippingCode: row.shippingCode,
      productCode: row.productCode ?? 'PAQ ESTÁNDAR',
      state: 'created',
      createdAt: at,
    }).onConflictDoNothing({ target: shipments.shippingCode }).returning({ id: shipments.id });

    if (ship) created += 1; else skipped += 1;

    // A number nobody could fix means this parcel gets no reminders. That is
    // not a silent outcome — it goes on the error report and into the batch.
    if (phone.status !== 'ok') {
      errors.push({
        row: row.n,
        customer: row.customerName,
        problem: phone.error ?? 'Cannot be messaged',
      });
    }
  }

  await db.update(importBatches).set({
    rowsNew: created,
    rowsDuplicate: skipped,
    rowsError: errors.length,
    rowsAutofixed: fixed,
    errorReport: errors,
    committedAt: now(),
  }).where(eq(importBatches.id, batch.id));

  await say(
    `${created} TikTok orders added, ${fixed} phone numbers fixed on the way in`
    + `${errors.length ? `, ${errors.length} left for you` : ''}.`,
  );

  return { batchId: batch.id, created, skipped, fixed };
}
