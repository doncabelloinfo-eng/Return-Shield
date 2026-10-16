'use client';

import { useEffect } from 'react';

/**
 * Registers the Scanner's service worker, scoped to /scan.
 *
 * Mounted from the scanner layout, so it runs on scanner pages and on no panel
 * page. The scope is what keeps that true after it is registered: a worker with
 * `{ scope: '/scan' }` cannot be asked to handle a request for /parcels even by
 * mistake.
 *
 * It is here for Chrome's install prompt, which has asked for a registered
 * worker with a fetch handler for most of its history. Nothing in the app
 * depends on it: the Scanner works offline-ish because every scan is written to
 * IndexedDB before it is sent, not because anything is cached.
 *
 * Failures are swallowed on purpose. A worker that will not register — a
 * private window, an unusual Android webview, an enterprise policy — costs the
 * install prompt and nothing else, and an unhandled rejection in a warehouse is
 * a red screen in front of somebody holding a parcel.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/scan-sw.js', { scope: '/scan' }).catch(() => {});
  }, []);

  return null;
}
