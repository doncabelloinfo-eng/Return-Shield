import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql as raw } from 'drizzle-orm';
import { db } from '@/db';
import {
  correosPushInbox, jobRuns, offices, orders, postcodeStats,
  shipmentEvents, shipments, stores, importBatches, tasks,
} from '@/db/schema';
import { now, DAY, HOUR } from '@/lib/clock';
import { madridParts, madridMidnightUtc, human, shortDate } from '@/lib/time';
import { normalisePayload } from '@/lib/carriers/correos/normalise';
import { trackpub } from '@/lib/carriers/correos/trackpub';
import { ingestEvent } from '@/lib/shipments/ingest';
import { liveShipmentIds } from '@/lib/shipments/repo';
import { runTick } from '@/lib/escalation/run';
import { openTask } from '@/lib/escalation/tasks';
import { getSettings } from '@/lib/settings';
import { say } from '@/lib/activity';
import { sendInternalAlert } from '@/lib/mail/send';
import { purgeExpiredSessions } from '@/lib/auth/session';
import { purgeRateLimits } from '@/lib/rate-limit';
import { callQueue, money } from '@/lib/escalation/decide';
import { loadRows, todayView } from '@/lib/views/rows';
import { storeEnv } from '@/lib/carriers/shopify/verify';
import { ingestShopifyOrder, type ShopifyOrderPayload } from '@/lib/carriers/shopify/ingest';

/**
 * Every scheduled job.
 *
 * All of them assume they will run twice — because they will. A worker
 * restarts mid-run, two workers overlap, somebody kicks one by hand. So every
 * job is written so that running it again changes nothing that has already
 * happened: the event table dedupes, tasks are unique per shipment and type,
 * and the escalation fires table means a rung can only fire once.
 */

export type JobName =
  | 'escalation-tick'
  | 'push-drain'
  | 'nightly-reconcile'
  | 'stale-detector'
  | 'daily-digest'
  | 'push-heartbeat'
  | 'shopify-backfill'
  | 'import-reminder'
  | 'postcode-stats'
  | 'housekeeping';

export interface JobResult { detail: Record<string, unknown> }

/** Wraps a job so every run is recorded, and a failure never kills the worker. */
export async function runJob(job: JobName, fn: () => Promise<JobResult>): Promise<void> {
  const [run] = await db.insert(jobRuns).values({ job, startedAt: now() })
    .returning({ id: jobRuns.id });

  try {
    const { detail } = await fn();
    await db.update(jobRuns)
      .set({ finishedAt: now(), ok: true, detail })
      .where(eq(jobRuns.id, run.id));
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    console.error(`[job:${job}] failed:`, message);
    await db.update(jobRuns)
      .set({ finishedAt: now(), ok: false, detail: { error: message } })
      .where(eq(jobRuns.id, run.id));
  }
}

/* ---------------------------------------------------------------- every 30m */

export async function escalationTick(): Promise<JobResult> {
  const ids = await liveShipmentIds();
  const result = await runTick(ids, now());
  return { detail: { ...result } };
}

/* -------------------------------------------------------- every minute-ish */

/**
 * Drain the Correos push staging table.
 *
 * The receiver returns 200 and writes the raw body; this turns those bodies
 * into events. Keeping the two apart is what makes a normaliser bug survivable:
 * clear `processed_at` on the affected rows and they run again.
 */
export async function drainPushInbox(limit = 200): Promise<JobResult> {
  const rows = await db.select().from(correosPushInbox)
    .where(isNull(correosPushInbox.processedAt))
    .orderBy(correosPushInbox.receivedAt)
    .limit(limit);

  let events = 0;
  let unknown = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const { events: list, problems } = normalisePayload(row.payload, 'push');
      for (const e of list) {
        const r = await ingestEvent(e);
        if (r.status === 'inserted') events += 1;
        if (r.status === 'unknown_shipment') unknown += 1;
      }
      await db.update(correosPushInbox).set({
        processedAt: now(),
        attempts: row.attempts + 1,
        lastError: problems.length ? problems.join('; ') : null,
      }).where(eq(correosPushInbox.id, row.id));
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Left unprocessed so it is retried, unless it has failed too often —
      // at which point it stays in the table as evidence rather than looping.
      await db.update(correosPushInbox).set({
        attempts: row.attempts + 1,
        lastError: message,
        processedAt: row.attempts >= 5 ? now() : null,
      }).where(eq(correosPushInbox.id, row.id));
    }
  }

  return { detail: { staged: rows.length, events, unknownShipments: unknown, failed } };
}

/* ------------------------------------------------------------- 03:00 Madrid */

/**
 * The safety net for push. Push has no guaranteed retry, so if the receiver
 * was down for an hour, this is the only thing that will ever notice.
 */
export async function nightlyReconcile(): Promise<JobResult> {
  const client = trackpub();
  if (!client.configured) {
    return { detail: { skipped: 'Correos credentials are not configured' } };
  }

  const ids = await liveShipmentIds();
  const codes = ids.length
    ? await db.select({ id: shipments.id, code: shipments.shippingCode })
        .from(shipments).where(inArray(shipments.id, ids))
    : [];

  let checked = 0;
  let recovered = 0;
  let missing = 0;
  const failures: string[] = [];

  for (const { code } of codes) {
    const r = await client.lookup(code);
    checked += 1;

    if (!r.ok) {
      if (r.status === 404) missing += 1;
      else failures.push(`${code}: ${r.error}`);
      // A rate limit or an outage means stop, not push harder. Tomorrow's
      // sweep picks up whatever is left; a blocked account picks up nothing.
      if (r.retryable && failures.length > 20) break;
      continue;
    }

    for (const e of r.outcome.events) {
      const ingested = await ingestEvent(e);
      if (ingested.status === 'inserted') recovered += 1;
    }
  }

  if (recovered > 0) {
    await say(`Nightly check with Correos found ${recovered} updates that never reached us`);
  }

  return { detail: { checked, recovered, missing, failures: failures.slice(0, 10) } };
}

/* ------------------------------------------------------------- 07:30 Madrid */

/**
 * Parcels Correos has gone quiet about. Only ones in motion: a parcel sitting
 * at a post office is meant to be silent for a fortnight, and flagging those
 * would bury the ones that actually vanished.
 */
export async function staleDetector(): Promise<JobResult> {
  const { staleAfterHours } = await getSettings();
  const cutoff = new Date(now().getTime() - staleAfterHours * HOUR);

  const rows = await db.select({
    id: shipments.id,
    customerName: orders.customerName,
    lastEventAt: shipments.lastEventAt,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(
      isNull(shipments.droppedAt),
      inArray(shipments.state, ['accepted', 'in_transit', 'out_for_delivery']),
      lt(shipments.lastEventAt, cutoff),
    ));

  const days = Math.round(staleAfterHours / 24);
  for (const r of rows) {
    await openTask({
      shipmentId: r.id,
      type: 'chase_carrier',
      reason: 'no_updates',
      label: `No update for ${days} days — ask Correos`,
    });
  }

  if (rows.length) {
    await say(`${rows.length} parcels have had no update for over ${days} days — on your list to ask Correos`);
  }

  return { detail: { flagged: rows.length, staleAfterHours } };
}

/* ------------------------------------------------------------- 08:00 Madrid */

/**
 * What to do today, in order. Not what happened yesterday — a digest of
 * history is a digest nobody opens twice.
 */
export async function dailyDigest(): Promise<JobResult> {
  const view = await todayView(0, now());

  if (!view.rows.length) {
    await sendInternalAlert({
      subject: 'Return Shield — nothing needs you today',
      lines: [
        'Every parcel is either moving normally or already handled.',
        '',
        'Nothing to do. Have a good morning.',
      ],
    });
    return { detail: { items: 0 } };
  }

  const lines: string[] = [view.headline, ''];
  for (const d of view.digest) lines.push(`· ${d}`);
  lines.push('', 'In order, most money at risk first:', '');

  view.rows.slice(0, 15).forEach((r, i) => {
    lines.push(`${i + 1}. ${r.action?.label ?? 'Look at it'} — ${r.customerName}`);
    lines.push(`   ${r.why}`);
    lines.push(`   ${r.orderNumber} · ${r.valueText}`
      + `${r.paymentMethod === 'cod' ? ' · cash on delivery' : ''}`
      + `${r.officeName ? ` · ${r.officeName}` : ''}`);
    lines.push(`   ${appUrl()}/parcel/${r.id}`);
    lines.push('');
  });

  if (view.rows.length > 15) lines.push(`...and ${view.rows.length - 15} more on the dashboard.`);

  await sendInternalAlert({
    subject: `Return Shield — ${view.headline}`,
    lines,
  });

  return { detail: { items: view.rows.length, calls: view.callCount } };
}

/* ----------------------------------------------------------------- hourly */

/**
 * No events during working hours means the integration broke, not that nothing
 * happened. Correos scans parcels all day; silence is a symptom.
 */
export async function pushHeartbeat(): Promise<JobResult> {
  const at = now();
  const hour = madridParts(at).hour;
  const weekday = madridParts(at).weekday;

  // Outside working hours, and on Sundays, silence is normal.
  if (hour < 9 || hour > 20 || weekday === 0) {
    return { detail: { skipped: 'outside working hours' } };
  }

  const since = new Date(at.getTime() - 3 * HOUR);
  const [row] = await db.select({ n: raw<number>`count(*)::int` })
    .from(shipmentEvents)
    .where(and(
      eq(shipmentEvents.source, 'push'),
      gt(shipmentEvents.receivedAt, since),
    ));

  const count = row?.n ?? 0;
  if (count > 0) return { detail: { events: count, healthy: true } };

  // Don't cry wolf when there is genuinely nothing in flight.
  const live = await liveShipmentIds();
  if (live.length === 0) return { detail: { events: 0, healthy: true, note: 'nothing in flight' } };

  await sendInternalAlert({
    subject: 'Return Shield — no tracking updates from Correos for three hours',
    lines: [
      `Nothing has arrived from Correos since ${shortDate(since)} and there are ${live.length} parcels in flight.`,
      '',
      'During working hours that usually means the push integration has broken rather than',
      'that nothing happened. Worth checking:',
      '',
      '  · is the push receiver reachable from outside?',
      '  · has the source IP Correos calls from changed?',
      '  · are CORREOS_PUSH_CLIENT_ID / _SECRET still right?',
      '',
      'The nightly reconcile will still pick everything up, so nothing is lost — but',
      'countdowns will be up to a day stale until push is back.',
    ],
  });

  return { detail: { events: 0, healthy: false, live: live.length } };
}

/* ----------------------------------------------------------------- hourly */

/**
 * Webhooks are lost more often than people expect. This pulls recent
 * fulfilments by API and inserts anything whose webhook never arrived.
 */
export async function shopifyBackfill(): Promise<JobResult> {
  const shopifyStores = await db.select().from(stores)
    .where(and(eq(stores.platform, 'shopify'), eq(stores.active, true)));

  let created = 0;
  let checked = 0;
  const skipped: string[] = [];

  for (const store of shopifyStores) {
    const token = storeEnv(store.key, 'ACCESS_TOKEN');
    const domain = store.shopDomain ?? storeEnv(store.key, 'SHOP_DOMAIN');

    if (!token || !domain) { skipped.push(store.key); continue; }

    const since = new Date(now().getTime() - 2 * DAY).toISOString();
    const url = `https://${domain}/admin/api/2024-10/orders.json`
      + `?status=any&fulfillment_status=shipped&updated_at_min=${encodeURIComponent(since)}&limit=100`;

    try {
      const res = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { skipped.push(`${store.key} (${res.status})`); continue; }

      const body = await res.json() as { orders?: ShopifyOrderPayload[] };
      for (const order of body.orders ?? []) {
        checked += 1;
        const r = await ingestShopifyOrder(store.key, order);
        created += r.shipmentIds.length;
      }
    } catch (err) {
      skipped.push(`${store.key} (${err instanceof Error ? err.message : 'unreachable'})`);
    }
  }

  if (created > 0) {
    await say(`Hourly check of Shopify found ${created} parcels whose webhook never arrived`);
  }

  return { detail: { checked, created, skipped } };
}

/* ------------------------------------------------------------- 09:00 Madrid */

/** Nudges if it has been more than a day since the last TikTok upload. */
export async function importReminder(): Promise<JobResult> {
  const [last] = await db.select({ createdAt: importBatches.createdAt })
    .from(importBatches)
    .where(isNotNull(importBatches.committedAt))
    .orderBy(desc(importBatches.createdAt))
    .limit(1);

  const at = now();
  const cutoff = new Date(at.getTime() - DAY);
  if (last && last.createdAt > cutoff) {
    return { detail: { lastUpload: last.createdAt, nudged: false } };
  }

  await sendInternalAlert({
    subject: 'Return Shield — TikTok orders have not been uploaded',
    lines: [
      last
        ? `The last TikTok upload was ${human(last.createdAt, at)}.`
        : 'No TikTok orders have ever been uploaded.',
      '',
      'TikTok parcels are invisible to this system until the file is uploaded, which means',
      'nobody is watching their countdowns. Shopify orders are unaffected.',
      '',
      `Upload here: ${appUrl()}/import`,
    ],
  });

  return { detail: { lastUpload: last?.createdAt ?? null, nudged: true } };
}

/* -------------------------------------------------------------- nightly */

/**
 * Rebuilds the failure rates behind the dispatch warning.
 *
 * An area is watched once it fails materially more than average *and* has
 * enough parcels for that to mean anything — flagging a postcode because its
 * only two parcels both failed would cry wolf at every new town.
 */
export async function rebuildPostcodeStats(): Promise<JobResult> {
  const { watchFailRateMultiple } = await getSettings();
  const MIN_SHIPPED = 8;

  const rows = await db.select({
    postalCode: orders.postalCode,
    town: orders.city,
    shipped: raw<number>`count(*)::int`,
    failed: raw<number>`count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM shipment_events e
      WHERE e.shipment_id = ${shipments.id} AND e.mapped_state = 'failed'
    ))::int`,
    returned: raw<number>`count(*) FILTER (WHERE ${shipments.state} IN ('returning', 'returned', 'refused'))::int`,
  })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(isNotNull(orders.postalCode), ne(orders.postalCode, '')))
    .groupBy(orders.postalCode, orders.city, shipments.id);

  // Fold the per-shipment grouping back up to one row per postcode.
  const byCode = new Map<string, { town: string | null; shipped: number; failed: number; returned: number }>();
  for (const r of rows) {
    const key = r.postalCode!;
    const acc = byCode.get(key) ?? { town: r.town, shipped: 0, failed: 0, returned: 0 };
    acc.shipped += r.shipped;
    acc.failed += r.failed;
    acc.returned += r.returned;
    acc.town ??= r.town;
    byCode.set(key, acc);
  }

  const totalShipped = [...byCode.values()].reduce((a, v) => a + v.shipped, 0);
  const totalFailed = [...byCode.values()].reduce((a, v) => a + v.failed, 0);
  const average = totalShipped ? totalFailed / totalShipped : 0;

  let watched = 0;
  const at = now();

  for (const [postalCode, v] of byCode) {
    const failRate = v.shipped ? v.failed / v.shipped : 0;
    const watch = v.shipped >= MIN_SHIPPED && average > 0 && failRate >= average * watchFailRateMultiple;
    if (watch) watched += 1;

    await db.insert(postcodeStats).values({
      postalCode,
      town: v.town,
      shipped: v.shipped,
      failed: v.failed,
      returned: v.returned,
      failRate,
      watch,
      rebuiltAt: at,
    }).onConflictDoUpdate({
      target: postcodeStats.postalCode,
      set: { town: v.town, shipped: v.shipped, failed: v.failed, returned: v.returned, failRate, watch, rebuiltAt: at },
    });
  }

  return { detail: { postcodes: byCode.size, watched, averageFailRate: Number(average.toFixed(4)) } };
}

/* -------------------------------------------------------------- nightly */

/** Expired sessions and old rate-limit buckets are dead weight and a liability. */
export async function housekeeping(): Promise<JobResult> {
  const [sessions, limits] = await Promise.all([purgeExpiredSessions(), purgeRateLimits()]);

  // Push payloads older than 90 days have served their purpose as evidence.
  const cutoff = new Date(now().getTime() - 90 * DAY);
  const inbox = await db.delete(correosPushInbox)
    .where(and(isNotNull(correosPushInbox.processedAt), lt(correosPushInbox.receivedAt, cutoff)))
    .returning({ id: correosPushInbox.id });

  return { detail: { sessions, rateLimitBuckets: limits, pushPayloads: inbox.length } };
}

function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}
