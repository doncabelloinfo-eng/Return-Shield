import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/session';
import { loadDemoClock } from '@/lib/demo-clock';
import { now } from '@/lib/clock';
import { EXPORT_CAP, isParcelTab, parcelsExport, parseDayFilter } from '@/lib/views/parcels';
import { filterLine, parcelsPdf, pdfFilename } from '@/lib/export/parcels-pdf';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/*
 * Same reason as every cron route: a GET with no cache option, inside a route
 * handler, goes into Next's Data Cache with a one-year revalidate. An export is
 * the last thing in this app that may be stale — somebody is going to pick
 * parcels off it. See tests/no-store.test.ts.
 */
export const fetchCache = 'force-no-store';
/*
 * Five thousand rows, each of which builds the Spanish office wording on the
 * way out of the view. Comfortably inside this at real volumes; EXPORT_CAP is
 * what keeps it inside at any volume.
 */
export const maxDuration = 60;

/**
 * The tab being viewed, as a PDF for the warehouse.
 *
 * A GET behind the login rather than an action that posts: the browser saves
 * the response and stays where it is, nothing is written, and the URL carries
 * exactly the query string the screen has — so whatever the tab, the search
 * box, the shop and the ship-date filter are showing is what lands in the
 * file. Which also makes it shareable: the operator can send somebody the link
 * instead of the file.
 *
 * It reuses `parcelsExport`, which is the screen's own query with the paging
 * taken off (lib/views/parcels.ts). The PDF's count therefore cannot disagree
 * with the number on the tab, and neither can its order.
 *
 * It does not close the database pool when it is done, and it inherits
 * `withDbRetry` from the view. See tests/pool-lifetime.test.ts for what the
 * first of those cost.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.DATABASE_URL) {
    return new NextResponse('No database is configured.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const user = await currentUser();
  if (!user) {
    // A navigation, so a redirect to /login would work too. A 401 says the
    // true thing: the download did not happen.
    return new NextResponse('Sign in to download this.', {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const params = new URL(req.url).searchParams;
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const store = params.get('store') ?? '';
  const date = params.get('date') ?? '';

  await loadDemoClock();
  const at = now();

  const view = await parcelsExport({
    status: isParcelTab(status) ? status : undefined,
    q,
    store,
    date,
    at,
  });

  const file = parcelsPdf(view.rows, {
    tabLabel: view.tab.en,
    total: view.total,
    capped: view.capped,
    /*
     * The heading's date comes from the SAME parse as the SQL predicate.
     *
     * It used to take the raw query string, which went wrong both ways round:
     * `?date=banana` reached `Intl.DateTimeFormat`, threw RangeError and
     * answered a download with a 500; and `?date=2026-10-6` — which
     * `parseDayFilter` rejects, so no ship-date predicate was added — still
     * printed "Shipped on 06 Oct 2026" on the first page. That second one is
     * the dangerous half: a file of every day's parcels under a one-day
     * heading, sent to a warehouse.
     */
    filters: filterLine({ q, store, date: parseDayFilter(date)?.key }),
    at,
  });

  /*
   * `new Uint8Array(file)`, not `file`.
   *
   * A Node `Buffer` is a `Uint8Array<ArrayBufferLike>`, and `BodyInit` wants a
   * `Uint8Array<ArrayBuffer>` — so passing the Buffer straight in compiles
   * under a bare `tsc` with no DOM/undici types in sight and fails
   * `next build`, which is how this reached a commit that could not deploy.
   * The copy is cheap and it is the overload that takes a typed array, so it
   * copies exactly these bytes rather than the whole pooled allocation a
   * Buffer may be a slice of. tests/typecheck.test.ts is what catches the
   * class.
   */
  return new NextResponse(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${pdfFilename(view.tab.en, at)}"`,
      'Content-Length': String(file.length),
      'Cache-Control': 'no-store, max-age=0',
      // Belt and braces with EXPORT_CAP: a client that asked for a tab with
      // more rows than one file may carry still gets a complete file, and the
      // first page says so.
      'X-Export-Rows': `${view.rows.length}/${view.total}${view.total > EXPORT_CAP ? ' capped' : ''}`,
    },
  });
}
