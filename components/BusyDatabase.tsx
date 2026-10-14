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
   * `tick` IS A DEPENDENCY, and it is a deliberate belt AND braces.
   *
   * There are two ways this schedule can advance after a retry fails, and
   * which one React actually takes is the one thing in this file that was not
   * settled by reading it:
   *
   *   · A REMOUNT. `finishClassComponent` in React 18 calls
   *     `forceUnmountCurrentAndReconcile` when a class boundary captures with
   *     a committed child — it deletes the fallback and mounts it fresh "even
   *     if the type and key are the same". Next's ErrorBoundaryHandler is such
   *     a boundary, so each failed retry would give this component a fresh
   *     mount, its effect would run again, and the module-scope `attempts`
   *     below would carry the schedule forward. That is what those two
   *     module-level values are for.
   *
   *   · THIS EFFECT RE-RUNNING. If the boundary instead reconciles the
   *     fallback as an update — which is what a transition that never commits
   *     its intermediate tree would do — no remount happens, and then a
   *     dependency list of `[onRetry]` alone arms exactly ONE timer, ever:
   *     the page tries once at three seconds and then says "Trying again…"
   *     for ever while doing nothing. Which is the bug this file exists to
   *     fix, reproduced by the fix.
   *
   * With `tick` in the list it works under both, and the cost of the
   * redundancy is small and bounded: if the component is still mounted when
   * the next attempt is due while the previous one is still in flight, a
   * second refresh is dispatched — at most eight over half a minute, from a
   * tab already sitting on an error page. The cost of guessing wrong the other
   * way is a page that never comes back, twice reported.
   *
   * It is settled by watching a browser, not by reading: stop Postgres, load a
   * page, start Postgres, and see whether the screen returns on its own.
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
      // Re-render, so that if React did NOT remount this component the effect
      // runs again and arms the next attempt. If the retry worked, the
      // boundary is gone and so is this timer.
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
