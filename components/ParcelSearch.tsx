'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { ScanFilterState } from '@/lib/views/parcels';

/**
 * Search and the shop filter, both inside whatever tab is selected.
 *
 * In the URL, like the tabs, and deliberately preserving `status` — typing a
 * name should narrow the status you are looking at rather than silently
 * throwing you back to everything.
 */
export function ParcelSearch({
  stores, current, scan,
}: {
  stores: string[];
  current: { q: string; store: string; date: string };
  /** Null on the tabs where "did it leave the warehouse?" answers nothing. */
  scan: ScanFilterState | null;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const set = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (!value || value === 'All shops') next.delete(key);
    else next.set(key, value);
    // A new search starts at page one; its page 3 is not this page 3.
    next.delete('page');
    router.replace(`/parcels${next.toString() ? `?${next}` : ''}`);
  }, [params, router]);

  const chip = (on: boolean) =>
    `whitespace-nowrap rounded border px-[10px] py-[7px] text-[11.5px] font-semibold ${
      on ? 'border-navy bg-navy text-white' : 'border-line bg-surface2 text-muted'}`;

  return (
    <div className="ml-auto w-full lg:w-auto">
      <div className="relative">
        <input
          defaultValue={current.q}
          onChange={(e) => set('q', e.target.value)}
          placeholder="Search name, order, code or town"
          aria-label="Search parcels"
          className="w-[min(320px,90vw)] rounded-[5px] border border-line bg-surface py-[9px] pl-[30px] pr-3 text-[13px] text-ink"
        />
        <span className="absolute left-[10px] top-[9px] text-[13px] text-muted">⌕</span>
      </div>

      <div className="mt-[10px] flex flex-wrap items-center gap-2 rounded-[5px] border border-line bg-surface px-3 py-[10px]">
        {stores.length > 1 && ['All shops', ...stores].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => set('store', s)}
            className={chip(s === 'All shops' ? !current.store : current.store === s)}
          >
            {s}
          </button>
        ))}

        {stores.length > 1 && <span className="mx-1 h-[22px] w-px bg-line" />}

        {/* By SHIP date, which is the question the operator actually has:
            "what went out on Tuesday". It narrows whatever tab is selected and
            combines with the search and the shop, and the counts follow it. */}
        <label className="flex items-center gap-[7px] text-[11.5px] font-semibold text-muted">
          Shipped on
          <input
            type="date"
            value={current.date}
            onChange={(e) => set('date', e.target.value)}
            aria-label="Shipped on this day"
            className="rounded border border-line bg-surface px-[8px] py-[6px] text-[12px] text-ink"
          />
        </label>

        {current.date && (
          <button type="button" onClick={() => set('date', '')} className={chip(false)}>
            Any day
          </button>
        )}

        {/*
          The warehouse filter, on the pre-admission tabs only.

          This is what the Scanner is for. A parcel that Correos still calls
          "Pre-admisión" is either with Correos and unscanned by them, or on a
          shelf here — opposite problems with opposite answers, and until the
          warehouse scanned parcels out nothing could tell them apart.

          Here, beside the other filters, rather than as a tab of its own: the
          PDF export reads these same search parameters, so the file the
          warehouse is sent is the list that was on screen.

          Both counts show even at zero, the same way every tab does. "Not
          scanned out (0)" is worth seeing — it is the morning everything went.
        */}
        {scan && (
          <>
            <span className="mx-1 h-[22px] w-px bg-line" />
            <button
              type="button"
              onClick={() => set('scanned', scan.current === 'out' ? '' : 'out')}
              aria-pressed={scan.current === 'out'}
              className={chip(scan.current === 'out')}
            >
              Left the warehouse ({scan.out})
            </button>
            <button
              type="button"
              onClick={() => set('scanned', scan.current === 'not' ? '' : 'not')}
              aria-pressed={scan.current === 'not'}
              className={chip(scan.current === 'not')}
            >
              Not scanned out ({scan.not})
            </button>
          </>
        )}
      </div>
    </div>
  );
}
