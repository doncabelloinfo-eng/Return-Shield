import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/session';
import { closeDb } from '@/db';
import { loadDemoClock } from '@/lib/demo-clock';
import { now } from '@/lib/clock';
import { progressLine, readProgress, viewProgress } from '@/lib/sweep-progress';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/*
 * Same reason as every cron route: a GET with no cache option, inside a route
 * handler, goes into Next's Data Cache with a one-year revalidate. A cached
 * progress bar is a progress bar that never moves. See
 * lib/carriers/correos/trackpub.ts for the day that cost.
 */
export const fetchCache = 'force-no-store';
export const maxDuration = 10;

/**
 * What the sweep running right now has got through.
 *
 * The browser polls this every second and a half while a sweep is going, so it
 * has exactly one job and does it in one query: read the `sweepProgress`
 * settings row and turn it into the numbers the bar draws. No joins, no counts,
 * no shipments table. A poll that costs a page's worth of work would make the
 * progress bar more expensive than the sweep it is watching.
 *
 * `currentUser` rather than `requireUser`: this is fetched by JavaScript, and
 * `requireUser` answers a signed-out request with a redirect to /login, which
 * a fetch follows and then fails to parse as JSON. A 401 is the honest answer
 * and the client stops polling on it.
 */
export async function GET(): Promise<NextResponse> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ progress: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const user = await currentUser();
    if (!user) {
      return NextResponse.json(
        { error: 'unauthorised' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    await loadDemoClock();
    const at = now();
    const view = viewProgress(await readProgress(), at);

    return NextResponse.json(
      {
        progress: view && view.show
          ? {
            label: view.label,
            state: view.state,
            total: view.total,
            checked: view.checked,
            changed: view.changed,
            left: view.left,
            percent: view.total > 0
              ? Math.min(100, Math.round((view.checked / view.total) * 100))
              : 0,
            line: progressLine(view),
            done: view.done,
          }
          : null,
      },
      // Belt and braces with `fetchCache` above: this header is what stops a
      // CDN or the browser itself holding on to a progress reading.
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } finally {
    // Serverless instances are frozen between invocations, and this route is
    // called every second and a half. Handing the connection back matters more
    // here than anywhere else in the app.
    await closeDb().catch(() => {});
  }
}
