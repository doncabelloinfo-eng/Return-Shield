import type { Metadata, Viewport } from 'next';
import { RegisterServiceWorker } from '@/components/scan/RegisterServiceWorker';

/**
 * The Scanner's own shell. Not the panel's.
 *
 * The panel layout runs four database queries around every screen — the
 * activity ticker, the to-do count, the engine health and the sweep status —
 * and draws a top bar, a status banner and two rows of tabs. A phone working
 * through a pile of three hundred parcels must not pay for any of it, and
 * nothing in it is of the slightest use in a warehouse.
 *
 * So this layout holds no queries at all. Each page under /scan does its own
 * guarding (`requireScanner`), which keeps /scan/login reachable while signed
 * out — and inside the installed app's scope, so an installed Scanner never
 * drops into a browser tab to sign in.
 *
 * THE MANIFEST IS LINKED HERE AND NOWHERE ELSE. Next merges nested metadata, so
 * declaring it in this layout puts `<link rel="manifest">` on /scan and its
 * children and on no panel page — which is what keeps "Install Scanner" from
 * appearing while somebody is reading the Parcels screen.
 */
export const metadata: Metadata = {
  title: 'Scanner',
  description: 'Scan the Correos label on every parcel going out or coming back.',
  manifest: '/scan/manifest.webmanifest',
  // iPhone has no install prompt; "Add to Home Screen" reads these instead.
  appleWebApp: { capable: true, title: 'Scanner', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  // The navy of the Scanner's own header, so the phone's status bar matches it.
  themeColor: '#10203D',
  width: 'device-width',
  initialScale: 1,
  // A scanning screen that zooms when a thumb brushes it is a scanning screen
  // pointing at the floor.
  maximumScale: 1,
  userScalable: false,
};

export default function ScanLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-ground text-ink">
      <RegisterServiceWorker />
      {children}
    </div>
  );
}
