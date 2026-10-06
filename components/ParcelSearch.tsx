'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Search and the shop filter, both inside whatever tab is selected.
 *
 * In the URL, like the tabs, and deliberately preserving `status` — typing a
 * name should narrow the status you are looking at rather than silently
 * throwing you back to everything.
 */
export function ParcelSearch({
  stores, current,
}: {
  stores: string[];
  current: { q: string; store: string };
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

      {stores.length > 1 && (
        <div className="mt-[10px] flex flex-wrap items-center gap-2 rounded-[5px] border border-line bg-surface px-3 py-[10px]">
          {['All shops', ...stores].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set('store', s)}
              className={chip(s === 'All shops' ? !current.store : current.store === s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
