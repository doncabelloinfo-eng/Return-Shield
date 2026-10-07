'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { refreshFromCorreos } from '@/app/actions/refresh';
import { useToast } from './Toast';

/**
 * "Refresh" — ask Correos now, from whichever screen the operator is on.
 *
 * It sits in the main menu rather than on the Post office or Parcels screen
 * because the question "has anything changed?" is asked from everywhere, and
 * because the answer changes every screen at once. Beside it, when Correos was
 * last asked — a button with no "last checked" next to it invites a press
 * every thirty seconds.
 *
 * `router.refresh()` afterwards, which re-runs the server components for the
 * current route: the new statuses appear on the screen the operator is already
 * looking at, without a page reload and without losing the tab or the filter
 * they had chosen.
 */
export function RefreshButton({ lastChecked, exactWhen }: {
  lastChecked: string | null;
  exactWhen: string | null;
}) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const busy = pending || asking;

  return (
    <div className="ml-auto flex items-center gap-[9px]">
      <span className="whitespace-nowrap text-[11.5px] text-muted" title={exactWhen ?? undefined}>
        {lastChecked ? `Last checked ${lastChecked}` : 'Correos has not been asked yet'}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setAsking(true);
          start(async () => {
            try {
              const r = await refreshFromCorreos();
              toast({ text: r.message });
              router.refresh();
            } finally {
              setAsking(false);
            }
          });
        }}
        className="whitespace-nowrap rounded-[5px] border border-navy px-[13px] py-[9px] text-[12.5px] font-semibold text-navy disabled:opacity-60"
      >
        {busy ? 'Asking Correos…' : 'Refresh'}
      </button>
    </div>
  );
}
