'use client';

/**
 * The same message when the failure took the layout with it.
 *
 * `app/(panel)/error.tsx` covers a page that threw inside a working layout.
 * This one replaces the whole document — so it has to bring its own `<html>`
 * and `<body>`, and it cannot use anything from the panel, including the
 * stylesheet's own classes being guaranteed to have loaded. Hence the inline
 * styles: a plain, readable page is worth more here than a styled one that
 * might render as unformatted text.
 */
export default function GlobalError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
            The database was busy for a moment. Trying again…
          </h1>

          <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: '#667085' }}>
            Nothing is lost and nothing was half-done — the page simply could not get a
            connection. Press the button, or reload.
          </p>

          <button
            type="button"
            onClick={() => reset()}
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
