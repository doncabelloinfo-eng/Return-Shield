'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Search and filters, kept in the URL rather than in component state — so a
 * filtered list can be sent to somebody, and so a refresh after acting on a
 * row does not throw away what was being looked at.
 */
export function OfficeFilters({
  stores, current,
}: {
  stores: string[];
  current: { q: string; store: string; pay: string; urg: string };
}) {
  const router = useRouter();
  const params = useSearchParams();

  const set = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (!value || value.startsWith('All') || value.startsWith('Any')) next.delete(key);
    else next.set(key, value);
    router.replace(`/office${next.toString() ? `?${next}` : ''}`);
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
          placeholder="Search name, order or code"
          aria-label="Search parcels"
          className="w-[min(300px,90vw)] rounded-[5px] border border-line bg-surface py-[9px] pl-[30px] pr-3 text-[13px] text-ink"
        />
        <span className="absolute left-[10px] top-[9px] text-[13px] text-muted">⌕</span>
      </div>

      <div className="mt-[10px] flex flex-wrap items-center gap-2 rounded-[5px] border border-line bg-surface px-3 py-[10px]">
        {stores.map((s) => (
          <button key={s} type="button" onClick={() => set('store', s)} className={chip(current.store === s)}>{s}</button>
        ))}
        <span className="mx-1 h-[22px] w-px bg-line" />
        {['Any payment', 'COD', 'Prepaid'].map((s) => (
          <button key={s} type="button" onClick={() => set('pay', s)} className={chip(current.pay === s)}>{s}</button>
        ))}
        <span className="mx-1 h-[22px] w-px bg-line" />
        {['All', '0–3', '4–7', '8+'].map((s) => (
          <button key={s} type="button" onClick={() => set('urg', s)} className={chip(current.urg === s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}
