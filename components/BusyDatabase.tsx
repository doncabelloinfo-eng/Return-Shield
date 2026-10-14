'use client';

import { useEffect, useState } from 'react';
import { attemptsSoFar, nextErrorRetryMs } from '@/lib/error-retry';

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
 * Shared by app/error.tsx and app/(panel)/error.tsx, which catch two different
 * segments and hand in two different ways of retrying. app/global-error.tsx
 * cannot use it: that one replaces the whole document, so it brings its own
 * markup and its own inline styles.
 */

/*
 * The attempt count is module scope on purpose.
 *
 * When a retry fails, the boundary renders this fallback again, and component
 * state cannot be relied on to survive that. A count that reset on every
 * failure would retry every few seconds for as long as the page was open,
 * which is the opposite of the bounded schedule in lib/error-retry.ts.
 */
let attempts = 0;
let lastAt = 0;

export function BusyDatabase({
  digest, onRetry,
}: {
  digest?: string;
  /** What to do to try again. Different per boundary; see each error.tsx. */
  onRetry: () => void;
}) {
  /*
   * `tick` IS A DEPENDENCY, and that is the whole mechanism.
   *
   * The timer below calls `setTick` to schedule the next attempt — but a state
   * update does not re-run an effect whose dependency list has not changed,
   * and `onRetry` never changes identity (it is a `useCallback` over a stable
   * router and a stable `reset`). With `[onRetry]` alone, exactly ONE timer
   * was ever armed: the page tried once at three seconds, and then said
   * "Trying again…" for ever while doing nothing — which is the bug this file
   * exists to fix, reproduced by the fix itself.
   */
  const [tick, setTick] = useState(0);
  const [trying, setTrying] = useState(true);

  useEffect(() => {
    attempts = attemptsSoFar(attempts, lastAt, Date.now());
    const delay = nextErrorRetryMs(attempts);

    if (delay === null) {
      setTrying(false);
      return undefined;
    }

    setTrying(true);
    const timer = setTimeout(() => {
      attempts += 1;
      lastAt = Date.now();
      // Re-render so this effect runs again and schedules the next attempt. If
      // the retry worked, the boundary is gone and so is the timer.
      setTick((n) => n + 1);
      onRetry();
    }, delay);

    return () => clearTimeout(timer);
  }, [onRetry, tick]);

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <div className="max-w-[560px] rounded-[5px] border border-line bg-surface p-5">
        <h1 className="m-0 font-display text-[17px] font-bold text-ink">
          {trying
            ? 'The database was busy for a moment. Trying again…'
            : 'The database is still busy.'}
        </h1>

        <p className="mt-2 text-[13px] leading-[1.5] text-muted">
          Nothing is lost and nothing was half-done — the screen simply could not get a
          connection.
          {' '}
          {trying
            ? 'This page is retrying by itself and will come back on its own.'
            : 'It has stopped retrying. Press the button whenever you are ready.'}
        </p>

        <button
          type="button"
          onClick={() => { attempts = 0; lastAt = 0; setTick((n) => n + 1); onRetry(); }}
          className="mt-[14px] rounded-[5px] border border-navy px-[13px] py-[9px] text-[12.5px] font-semibold text-navy"
        >
          Try again
        </button>

        {digest && (
          <p className="mt-[14px] text-[10.5px] text-muted">
            For support: digest {digest}
          </p>
        )}
      </div>
    </div>
  );
}
