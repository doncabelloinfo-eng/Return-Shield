'use client';

import { useEffect, useState } from 'react';
import { NEW_INCIDENT_AFTER_MS, nextErrorRetryMs } from '@/lib/error-retry';

/**
 * The last resort: an error in the root layout itself.
 *
 * Everything below the root layout is caught by app/error.tsx now, which keeps
 * the stylesheet and the theme. This one replaces the whole document — so it
 * brings its own `<html>` and `<body>`, and cannot assume the stylesheet's
 * classes are available, hence the inline styles. A plain readable page is
 * worth more here than a styled one that might arrive as unformatted text.
 *
 * It had no automatic retry at all, which is how the operator ended up on a
 * page that said "Trying again…" and never did. `reset()` is no use at this
 * level either — there is no router context and nothing above to re-render —
 * so recovery is a document reload, on the same bounded schedule as the other
 * boundaries (lib/error-retry.ts).
 */

/**
 * The count has to survive the reload, so it lives in `sessionStorage`.
 *
 * Without this, every reload would be a fresh mount with a fresh count, and a
 * database that stays down would mean a page reloading itself every three
 * seconds for as long as the tab was open. On a browser that refuses storage
 * there is no safe way to count, so the automatic retry is simply off and the
 * button does the work.
 */
const KEY = 'rs-global-error-retry';

function claimNextRetry(): number | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const prior = raw ? JSON.parse(raw) as { attempts?: number; at?: number } : null;
    const at = Date.now();
    const fresh = !prior?.at || at - prior.at > NEW_INCIDENT_AFTER_MS;
    const attempts = fresh ? 0 : Math.max(0, Number(prior?.attempts) || 0);

    const delay = nextErrorRetryMs(attempts);
    if (delay === null) return null;

    // Written before the reload, not after: after it, this code is gone.
    window.sessionStorage.setItem(KEY, JSON.stringify({ attempts: attempts + 1, at }));
    return delay;
  } catch {
    return null;
  }
}

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    const delay = claimNextRetry();
    if (delay === null) return undefined;

    setTrying(true);
    const timer = setTimeout(() => { window.location.reload(); }, delay);
    return () => clearTimeout(timer);
  }, []);

  return (
    <html lang="en">
      <body style={{
        margin: 0,
        padding: '40px 20px',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
        background: '#F5F7FA',
        color: '#101828',
      }}
      >
        <div style={{
          maxWidth: 560,
          margin: '0 auto',
          background: '#FFFFFF',
          border: '1px solid #E3E8EF',
          borderRadius: 5,
          padding: 20,
        }}
        >
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {trying
              ? 'The database was busy for a moment. Trying again…'
              : 'The database is still busy.'}
          </h1>

          <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: '#667085' }}>
            Nothing is lost and nothing was half-done — the page simply could not get a
            connection.
            {' '}
            {trying
              ? 'This page is reloading itself and will come back on its own.'
              : 'Press the button whenever you are ready.'}
          </p>

          <button
            type="button"
            onClick={() => {
              // A reload, for the same reason the automatic retry is one: at
              // this level there is nothing above to re-render.
              try { window.sessionStorage.removeItem(KEY); } catch { /* fine */ }
              window.location.reload();
            }}
            style={{
              marginTop: 14,
              border: '1px solid #15306B',
              borderRadius: 5,
              background: 'transparent',
              color: '#15306B',
              padding: '9px 13px',
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>

          {error.digest && (
            <p style={{ marginTop: 14, fontSize: 10.5, color: '#667085' }}>
              For support: digest {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
