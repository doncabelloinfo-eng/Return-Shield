import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { shipments, stores } from '@/db/schema';
import { adminApiUrl } from './api';
import { storeEnv } from './verify';
import { isCorreos, ingestShopifyOrder, fulfilledAt, type ShopifyOrderPayload } from './ingest';
import { cutoffFor } from '@/lib/cleanup';
import { retentionDays } from '@/lib/retention';
import { now } from '@/lib/clock';
import { say } from '@/lib/activity';

/**
 * Reading orders out of Shopify, a page at a time.
 *
 * The hourly check used to ask for `limit: 100` and read the first page only.
 * At a thousand parcels a day that is already short: two days of orders is
 * several hundred, so the check was quietly looking at a fraction of them and
 * reporting success. Shopify pages with a `Link` header and nothing says you
 * have stopped early — the page simply ends.
 *
 * It also asked for `fulfillment_status=shipped`, which leaves out partially
 * fulfilled orders: an order with one item posted and one still to pack is
 * `partial`, and its posted parcel is as real as any other. So the filter is
 * `any` and the decision is made on the fulfilments themselves.
 */

/** Shopify's own ceiling per page. */
export const PAGE_LIMIT = 250;

/** Stop before Vercel kills the function, so a long pull can resume. */
const DEFAULT_BUDGET_MS = 240_000;

export interface PullOptions {
  /** Injected by tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Wall-clock budget. The pull stops between pages, never mid-page. */
  budgetMs?: number;
  /** Pages to read at most. A backstop, not a limit anybody should hit. */
  maxPages?: number;
}

export interface PullReport {
  store: string;
  /** Orders Shopify handed us, across every page. */
  checked: number;
  /** Parcels that did not exist before. */
  added: number;
  /** Parcels we already had. Pressing twice lands here. */
  alreadyHad: number;
  /** Orders with no Correos fulfilment. TikTok's live here. */
  notCorreos: number;
  /** Fulfilments outside the window, left alone. */
  outsideWindow: number;
  pages: number;
  windowDays: number;
  from: string;
  stoppedEarly: string | null;
}

/**
 * Follow Shopify's `Link` header.
 *
 * Cursor paging, not offsets: the header carries an opaque `page_info` and the
 * only correct way to get the next page is to use the URL Shopify handed back.
 * Building it by hand works until an order changes mid-pull and the cursor
 * shifts under you.
 */
export function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

interface FetchedPage {
  orders: ShopifyOrderPayload[];
  next: string | null;
}

async function readPage(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<FetchedPage | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'unreachable' };
  }

  if (!res.ok) return { error: `Shopify returned ${res.status}` };

  const body = await res.json().catch(() => ({})) as { orders?: ShopifyOrderPayload[] };
  return { orders: body.orders ?? [], next: nextPageUrl(res.headers.get('link')) };
}

/**
 * Pull one store's recent orders and create anything missing.
 *
 * `from` is never earlier than the retention window: a parcel posted before it
 * would be deleted the same night, so pulling it is work the cleanup undoes
 * while the operator watches the count go up.
 */
export async function pullStore(
  storeKey: string,
  opts: PullOptions & { from?: Date } = {},
): Promise<PullReport> {
  const [store] = await getDb().select().from(stores).where(eq(stores.key, storeKey)).limit(1);
  if (!store) throw new Error(`shopify: no store with key "${storeKey}"`);

  const at = now();
  const windowStart = cutoffFor(at);
  // Clamped, not just defaulted. An operator asking for sixty days would
  // otherwise watch a thousand parcels arrive and vanish overnight.
  const from = opts.from && opts.from > windowStart ? opts.from : windowStart;

  const token = storeEnv(store.key, 'ACCESS_TOKEN');
  const domain = store.shopDomain ?? storeEnv(store.key, 'SHOP_DOMAIN');

  const report: PullReport = {
    store: store.name,
    checked: 0,
    added: 0,
    alreadyHad: 0,
    notCorreos: 0,
    outsideWindow: 0,
    pages: 0,
    windowDays: retentionDays(),
    from: from.toISOString(),
    stoppedEarly: null,
  };

  if (!token || !domain) {
    report.stoppedEarly = `${store.name} has no Admin API token — see docs/deploying.md`;
    return report;
  }

  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxPages = opts.maxPages ?? 200;
  const startedAt = Date.now();

  let url: string | null = adminApiUrl(domain, 'orders.json', {
    status: 'any',
    // `any`, not `shipped`: a partially fulfilled order is `partial`, and its
    // posted parcel is as real as any other.
    fulfillment_status: 'any',
    updated_at_min: from.toISOString(),
    limit: String(PAGE_LIMIT),
  });

  const fresh: string[] = [];

  while (url) {
    // Checked between pages, never inside one. Being killed mid-page would
    // leave a cursor nobody holds and the next press would start again.
    if (Date.now() - startedAt > budgetMs) {
      report.stoppedEarly = 'ran out of time — press it again to carry on';
      break;
    }
    if (report.pages >= maxPages) {
      report.stoppedEarly = `stopped after ${maxPages} pages`;
      break;
    }

    const page = await readPage(url, token, fetchImpl);
    if ('error' in page) {
      report.stoppedEarly = page.error;
      break;
    }

    report.pages += 1;

    for (const order of page.orders) {
      report.checked += 1;

      const correos = (order.fulfillments ?? []).filter(isCorreos);
      if (!correos.length) { report.notCorreos += 1; continue; }

      /*
       * The FULFILMENT's own date decides, not the order's. An order updated
       * yesterday can carry a parcel posted six weeks ago — `updated_at_min`
       * is about the order record, not about when anything shipped — and
       * pulling that parcel in would hand it straight to tonight's cleanup.
       */
      const inWindow = correos.filter((f) => {
        const shipped = fulfilledAt([f], trackingOf(f));
        return shipped !== null && shipped >= from;
      });

      if (!inWindow.length) { report.outsideWindow += 1; continue; }

      const result = await ingestShopifyOrder(
        store.key,
        { ...order, fulfillments: inWindow },
        // Quiet: the pull says one line at the end, not one per order.
        { quiet: true },
      );
      if (result.status === 'created') {
        report.added += result.shipmentIds.length;
        fresh.push(...result.shipmentIds);
      } else if (result.status === 'existing') {
        report.alreadyHad += Math.max(1, result.shipmentIds.length);
      } else {
        report.notCorreos += 1;
      }
    }

    url = page.next;
  }

  /*
   * ONE line, not one per order.
   *
   * `ingestShopifyOrder` narrates each parcel it creates, which is right for a
   * webhook — one order, one line — and wrong for a thousand: the ticker holds
   * twenty-four hours and a pull would bury a whole day of real events under
   * history. So the per-parcel lines are suppressed for a pull and this says
   * what happened once.
   */
  if (report.added > 0) {
    await say(
      `Pulled ${report.added} ${report.added === 1 ? 'parcel' : 'parcels'} `
      + `from the last ${report.windowDays} days of ${store.name}`,
      fresh[0],
    );
  }

  return report;
}

function trackingOf(f: { tracking_number?: string | null; tracking_numbers?: string[] | null }): string {
  return (f.tracking_number ?? f.tracking_numbers?.[0] ?? '').trim().toUpperCase();
}

/** Parcels created by a pull that Correos has not been asked about yet. */
export async function unsweptCount(): Promise<number> {
  const rows = await getDb().select({ id: shipments.id }).from(shipments)
    .where(and(eq(shipments.state, 'created')));
  return rows.length;
}
