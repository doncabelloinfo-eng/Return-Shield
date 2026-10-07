import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { importBatches, orders, shipments, stores } from '@/db/schema';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';
import { normalisePhone } from './phone';
import { SOURCE_STORE, type PreviewRow } from './parse';

/** Shop names for the ticker line, by platform. */
const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok orders',
  amazon: 'Amazon orders',
  shopify: 'Shopify orders',
};

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
  /** How many went to each shop, for the ticker line. */
  bySource: { label: string; count: number }[];
}

export async function commitImport(params: {
  /** The shop a full-format file belongs to. Tracking rows pick their own. */
  storeKey: string;
  filename: string;
  userId: string;
  rows: PreviewRow[];
  /** Numbers a person typed into the preview, by row number. */
  fixes: Record<number, string>;
}): Promise<CommitResult> {
  const [store] = await getDb().select().from(stores).where(eq(stores.key, params.storeKey)).limit(1);
  if (!store) throw new Error(`import: no store with key "${params.storeKey}"`);

  const at = now();
  /*
   * A row goes to the shop its own order id names, not to the shop the upload
   * was started from. One file can hold both kinds — the operator exports
   * whatever the marketplace gave them — and sending an Amazon order to the
   * TikTok shop would put the wrong name on the row and the wrong link in the
   * contact column.
   *
   * Each marketplace shop is created the first time one of its orders turns
   * up, the way the TikTok one always was. There is no setup step.
   */
  const storeCache = new Map<string, { id: string; platform: string }>([
    [params.storeKey, { id: store.id, platform: store.platform }],
  ]);

  async function storeFor(row: PreviewRow): Promise<{ id: string; platform: string }> {
    if (row.source !== 'tiktok' && row.source !== 'amazon') {
      return storeCache.get(params.storeKey)!;
    }

    const spec = SOURCE_STORE[row.source];
    const cached = storeCache.get(spec.key);
    if (cached) return cached;

    const [created] = await getDb().insert(stores).values({
      key: spec.key,
      name: spec.name,
      platform: spec.platform,
      ingest: 'manual',
    }).onConflictDoUpdate({ target: stores.key, set: { active: true } })
      .returning({ id: stores.id, platform: stores.platform });

    const resolved = { id: created.id, platform: created.platform };
    storeCache.set(spec.key, resolved);
    return resolved;
  }
  let created = 0;
  let skipped = 0;
  let fixed = 0;
  const byStore = new Map<string, number>();
  const errors: { row: number; customer: string; problem: string }[] = [];

  const [batch] = await getDb().insert(importBatches).values({
    storeId: store.id,
    filename: params.filename,
    uploadedBy: params.userId,
    rowsTotal: params.rows.length,
    createdAt: at,
  }).returning({ id: importBatches.id });

  for (const row of params.rows) {
    if (row.status === 'duplicate') { skipped += 1; continue; }
    // A row the preview refused — no tracking code, an order id nobody can
    // place, the wrong carrier — is not written. The preview already told the
    // operator why, and importing it anyway would make that a lie.
    if (row.status === 'needs_you' && row.error) {
      skipped += 1;
      errors.push({ row: row.n, customer: row.customerName, problem: row.error });
      continue;
    }

    // A number typed into the preview replaces whatever was in the file.
    const typed = params.fixes[row.n]?.trim();
    const phone = typed ? normalisePhone(typed) : row.phone;

    if (!row.shippingCode) {
      skipped += 1;
      errors.push({ row: row.n, customer: row.customerName, problem: 'No tracking code' });
      continue;
    }

    if (row.phone.fixes.length || typed) fixed += 1;

    const target = await storeFor(row);
    const marketplace = row.source === 'tiktok' || row.source === 'amazon';

    const [order] = await getDb().insert(orders).values({
      storeId: target.id,
      externalOrderId: row.orderId || row.shippingCode,
      orderNumber: row.orderId || row.shippingCode,
      // The empty string, not "Unknown customer". These files have no name,
      // and a placeholder in the database leaks into the Spanish message as
      // "Hola Unknown". The screens label it; see lib/orders/customer-label.ts.
      customerName: row.customerName.trim(),
      phoneE164: phone.e164,
      phoneRaw: phone.raw,
      phoneStatus: phone.status,
      email: row.email,
      addressLine: row.address,
      city: row.city,
      postalCode: row.postalCode,
      totalValueCents: row.valueCents,
      paymentMethod: row.paymentMethod,
      // Null, not the ship date. These files have no order date at all, and
      // writing the ship date here made the two columns on the Parcels screen
      // say the same thing while claiming the order was placed the day it was
      // posted. The screen shows "—".
      placedAt: marketplace ? null : (row.shippedAt ?? at),
      createdAt: at,
    }).onConflictDoUpdate({
      target: [orders.storeId, orders.externalOrderId],
      set: { phoneE164: phone.e164, phoneStatus: phone.status, phoneRaw: phone.raw },
    }).returning({ id: orders.id });

    const [ship] = await getDb().insert(shipments).values({
      orderId: order.id,
      carrier: 'correos',
      shippingCode: row.shippingCode,
      productCode: row.productCode ?? 'PAQ ESTÁNDAR',
      state: 'created',
      // The file's own `ship-date`. A date with no time is that Madrid day.
      shippedAt: row.shippedAt,
      createdAt: at,
    }).onConflictDoNothing({ target: shipments.shippingCode }).returning({ id: shipments.id });

    if (ship) {
      created += 1;
      byStore.set(target.platform, (byStore.get(target.platform) ?? 0) + 1);
    } else {
      skipped += 1;
    }

    /*
     * A number nobody could fix means this parcel gets no reminders. That is
     * not a silent outcome — it goes on the error report and into the batch.
     *
     * Except for the marketplace parcels, where there was never a number to
     * fix. Reporting those would put every row of an eighty-row Amazon file on
     * the error report and bury the ones that are genuinely wrong.
     */
    if (phone.status !== 'ok' && !marketplace) {
      errors.push({
        row: row.n,
        customer: row.customerName,
        problem: phone.error ?? 'Cannot be messaged',
      });
    }
  }

  await getDb().update(importBatches).set({
    rowsNew: created,
    rowsDuplicate: skipped,
    rowsError: errors.length,
    rowsAutofixed: fixed,
    errorReport: errors,
    committedAt: now(),
  }).where(eq(importBatches.id, batch.id));

  const bySource = [...byStore.entries()]
    .map(([platform, count]) => ({ label: PLATFORM_LABEL[platform] ?? platform, count }))
    .sort((a, b) => b.count - a.count);

  const what = bySource.length
    ? bySource.map((b) => `${b.count} ${b.label}`).join(' · ')
    : `${created} orders`;

  await say(
    `${what} added from ${params.filename}`
    + `${fixed ? `, ${fixed} phone numbers fixed on the way in` : ''}`
    + `${errors.length ? `, ${errors.length} left for you` : ''}.`,
  );

  return { batchId: batch.id, created, skipped, fixed, bySource };
}
