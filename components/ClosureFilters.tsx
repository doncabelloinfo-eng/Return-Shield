'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/** Reason, shop and month, in the URL, keeping the tab. */
export function ClosureFilters({
  reasons, stores, months, current,
}: {
  reasons: { id: string; label: string }[];
  stores: string[];
  months: string[];
  current: { reason: string; store: string; month: string };
}) {
  const router = useRouter();
  const params = useSearchParams();

  const set = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (!value) next.delete(key);
    else next.set(key, value);
    next.delete('page');
    router.replace(`/parcels?${next}`);
  }, [params, router]);

  const chip = (on: boolean) =>
    `whitespace-nowrap rounded border px-[10px] py-[7px] text-[11.5px] font-semibold ${
      on ? 'border-navy bg-navy text-white' : 'border-line bg-surface2 text-muted'}`;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[5px] border border-line bg-surface px-3 py-[10px]">
      <button type="button" onClick={() => set('reason', '')} className={chip(!current.reason)}>
        Every reason
      </button>
      {reasons.map((r) => (
        <button key={r.id} type="button" onClick={() => set('reason', r.id)} className={chip(current.reason === r.id)}>
          {r.label}
        </button>
      ))}

      {stores.length > 1 && (
        <>
          <span className="mx-1 h-[22px] w-px bg-line" />
          <button type="button" onClick={() => set('store', '')} className={chip(!current.store)}>All shops</button>
          {stores.map((s) => (
            <button key={s} type="button" onClick={() => set('store', s)} className={chip(current.store === s)}>{s}</button>
          ))}
        </>
      )}

      {months.length > 0 && (
        <>
          <span className="mx-1 h-[22px] w-px bg-line" />
          <button type="button" onClick={() => set('month', '')} className={chip(!current.month)}>Any month</button>
          {months.slice(0, 12).map((m) => (
            <button key={m} type="button" onClick={() => set('month', m)} className={chip(current.month === m)}>{m}</button>
          ))}
        </>
      )}
    </div>
  );
}
