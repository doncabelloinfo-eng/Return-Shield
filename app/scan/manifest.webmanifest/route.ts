import { NextResponse } from 'next/server';

/**
 * The Scanner's web app manifest.
 *
 * SCOPED TO /scan, which is the whole point of it. The manifest is linked from
 * the scanner layout and from nowhere else (app/scan/layout.tsx), so Chrome
 * never offers to install "Scanner" while somebody is reading the Parcels
 * screen — and `scope` means that once it IS installed, every scanner URL opens
 * inside the app rather than bouncing out to a browser tab. /scan/login is
 * inside that scope on purpose: a phone whose session has gone signs in without
 * ever leaving the installed app.
 *
 * It is a route rather than app/manifest.ts because Next's file convention
 * serves that at the root, for the whole site, which is exactly what must not
 * happen here.
 *
 * Static, and public. Chrome fetches a manifest WITHOUT credentials unless the
 * link carries `crossorigin`, so a manifest behind the session guard would
 * simply never load and the install prompt would never appear. There is nothing
 * in it worth guarding.
 */
export const dynamic = 'force-static';

const MANIFEST = {
  name: 'Scanner',
  short_name: 'Scanner',
  description: 'Scan the Correos label on every parcel going out or coming back.',
  start_url: '/scan',
  scope: '/scan',
  display: 'standalone',
  orientation: 'portrait',
  // app/globals.css: --ground and --navy.
  background_color: '#F4F6F9',
  theme_color: '#10203D',
  lang: 'en',
  dir: 'ltr',
  categories: ['productivity', 'utilities'],
  icons: [
    { src: '/scan/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/scan/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/scan/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

export function GET(): NextResponse {
  return NextResponse.json(MANIFEST, {
    headers: {
      'Content-Type': 'application/manifest+json',
      // An hour. Long enough that a phone is not re-fetching it all day, short
      // enough that a changed icon arrives the same morning.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
