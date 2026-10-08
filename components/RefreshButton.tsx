'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { refreshFromCorreos } from '@/app/actions/refresh';
import { useToast } from './Toast';

/**
 * "Refresh" — ask Correos now, from whichever screen the operator is on, and
 * WATCH IT HAPPEN.
 *
 * It sits in the main menu rather than on one screen because the question "has
 * anything changed?" is asked from everywhere, and because the answer changes
 * every screen at once.
 *
 * The bar is the part that was missing. A button that says "Asking Correos…"
 * for two minutes is indistinguishable from a button that has hung, so this
 * polls a small route every second and a half and draws what the sweep has
 * actually got through.
 *
 * Three things fall out of the progress row living in the database rather than
 * in this component's state, and all three are the point:
 *
 *   · the HOURLY CRON shows up here too, labelled "Automatic check", because
 *     it writes the same row from a different serverless instance. The
 *     operator can see the engine working without reading a job table;
 *   · pressing Refresh while a sweep is running shows THAT sweep rather than
 *     starting another, because the bar is already drawing it;
 *   · the final line stays for a while after it finishes, because "what did
 *     that do" is a question asked after the event.
 */

interface Progress {
  label: string;
  state: 'running' | 'finished' | 'abandoned';
  total: number;
  checked: number;
  changed: number;
  left: number;
  percent: number;
  line: string;
  done: boolean;
}

/** Fast enough to look live, slow enough that nobody notices the requests. */
const POLL_MS = 1500;

/**
 * How often to look when nothing is happening.
 *
 * The hourly cron has to be able to appear on a screen somebody is already
 * looking at, so the polling cannot stop altogether — but it does not need to
 * be every second and a half to catch a run that lasts a minute.
 */
const IDLE_POLL_MS = 20_000;

export function RefreshButton({ lastChecked, exactWhen }: {
  lastChecked: string | null;
  exactWhen: string | null;
}) {
  const [pending, start] = useTransition();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [asking, setAsking] = useState(false);
  const router = useRouter();
  const toast = useToast();

  /**
   * `useRef` for the refresh callback, so the polling effect does not restart
   * every time the router object changes identity. A poll loop that restarts
   * on every render is a poll loop that never fires.
   */
  const refreshed = useRef(false);

  const poll = useCallback(async (): Promise<Progress | null> => {
    try {
      const res = await fetch('/api/sweep-progress', { cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json() as { progress: Progress | null };
      return body.progress ?? null;
    } catch {
      // A failed poll is not worth saying anything about: the next one is a
      // second and a half away, and a toast per dropped request during a
      // network blip would bury the screen.
      return null;
    }
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      const next = await poll();
      if (!live) return;

      setProgress(next);

      /*
       * A sweep that has just finished changed the data on screen. Re-read it
       * once — not on every poll, or a two-minute sweep would re-render the
       * whole page eighty times.
       */
      if (next?.done && !refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
      if (next && !next.done) refreshed.current = false;

      timer = setTimeout(tick, next && !next.done ? POLL_MS : IDLE_POLL_MS);
    };

    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [poll, router]);

  const running = progress?.state === 'running';
  // Disabled while a sweep is running, whoever started it: a second press
  // during the automatic check would only be told it could not have the lock.
  const busy = pending || asking || running;

  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-[9px] gap-y-[6px]">
      {progress ? (
        <div className="min-w-[230px] flex-1 basis-[260px]">
          <div className="h-[6px] overflow-hidden rounded bg-line">
            <span
              className="block h-full transition-[width] duration-500 ease-out"
              style={{
                width: `${progress.percent}%`,
                background: progress.done ? 'var(--good)' : 'var(--navy)',
              }}
            />
          </div>
          <div className="mt-[4px] truncate text-[11.5px] text-muted" title={progress.line}>
            {progress.line}
          </div>
        </div>
      ) : (
        <span className="whitespace-nowrap text-[11.5px] text-muted" title={exactWhen ?? undefined}>
          {lastChecked ? `Last checked ${lastChecked}` : 'Correos has not been asked yet'}
        </span>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setAsking(true);
          start(async () => {
            try {
              const r = await refreshFromCorreos();
              // Only worth a toast when nothing started. When a sweep did
              // start, the bar says everything this message would, and better.
              if (!r.swept) toast({ text: r.message });
              const next = await poll();
              setProgress(next);
              if (!r.swept) router.refresh();
            } finally {
              setAsking(false);
            }
          });
        }}
        className="whitespace-nowrap rounded-[5px] border border-navy px-[13px] py-[9px] text-[12.5px] font-semibold text-navy disabled:opacity-60"
      >
        {running ? progress?.label === 'Automatic check' ? 'Checking…' : 'Asking Correos…'
          : busy ? 'Asking Correos…'
            : 'Refresh'}
      </button>
    </div>
  );
}
