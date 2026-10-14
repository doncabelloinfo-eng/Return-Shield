'use client';

import { useEffect, useState } from 'react';

/**
 * ONCE PER INCIDENT, and the flag has to live outside the component.
 *
 * `reset()` re-renders the segment; if it throws again this component is
 * mounted again with fresh state, so a plain `useState` guard would arm
 * another timer and retry every three seconds for ever. Module scope survives
 * the re-mount, and the window means a genuinely new failure half an hour
 * later still gets its own automatic try.
 */
let lastAutoRetry = 0;
const AUTO_RETRY_EVERY_MS = 30_000;

/**
 * What a full pooler looks like now.
 *
 * It used to look like this, on whichever screen lost the race:
 *
 *   Application error: a server-side exception has occurred (see the server
 *   logs for more information). Digest: 3880840699
 *
 * Which tells the operator nothing they can act on, and is not even true in
 * spirit: nothing had crashed. Every one of the 109 of those in a week was the
 * same momentary refusal — "max clients reached in session mode" — and the
 * right answer to it is to wait a second and ask again.
 *
 * So this says what happened in words, tries again by itself after three
 * seconds, and leaves a button for when that was not enough. The digest stays,
 * in small print, because it is the one thing that makes a report searchable
 * in the Vercel logs.
 *
 * Next requires this file to be a client component, and `reset()` re-renders
 * the segment on the server without a full page load.
 */

export default function PanelError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [retrying, setRetrying] = useState(() => Date.now() - lastAutoRetry > AUTO_RETRY_EVERY_MS);

  useEffect(() => {
    if (Date.now() - lastAutoRetry <= AUTO_RETRY_EVERY_MS) return undefined;
    lastAutoRetry = Date.now();

    const timer = setTimeout(() => {
      setRetrying(false);
      reset();
    }, 3_000);
    return () => clearTimeout(timer);
  }, [reset]);

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <div className="max-w-[560px] rounded-[5px] border border-line bg-surface p-5">
        <h1 className="m-0 font-display text-[17px] font-bold text-ink">
          The database was busy for a moment. Trying again…
        </h1>

        <p className="mt-2 text-[13px] leading-[1.5] text-muted">
          Nothing is lost and nothing was half-done — the screen simply could not get a
          connection. {retrying ? 'Reloading it in a moment.' : 'Press the button to try again.'}
        </p>

        <button
          type="button"
          onClick={() => { setRetrying(true); reset(); }}
          className="mt-[14px] rounded-[5px] border border-navy px-[13px] py-[9px] text-[12.5px] font-semibold text-navy"
        >
          Try again
        </button>

        {error.digest && (
          <p className="mt-[14px] text-[10.5px] text-muted">
            For support: digest {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
