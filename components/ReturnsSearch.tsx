'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * The Returns tab's own search box.
 *
 * Its own parameter, `rq`, rather than the Parcels search: this list is keyed
 * on the Correos code and nothing else — there is no customer name or town on a
 * scan to search — and sharing `q` would mean a code typed here narrowed every
 * other tab's count by a name search that could never match.
 */
export function ReturnsSearch({ value, note }: { value: string; note: string }) {
  const router = useRouter();
  const params = useSearchParams();

  const set = useCallback((next: string) => {
    const query = new URLSearchParams(params.toString());
    if (next) query.set('rq', next);
    else query.delete('rq');
    router.replace(`/parcels?${query}`);
  }, [params, router]);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[5px] border border-line bg-surface px-3 py-[10px]">
      <div className="relative">
        <input
          defaultValue={value}
          onChange={(e) => set(e.target.value)}
          placeholder="Search the number on the label"
          aria-label="Search returns by code"
          className="w-[min(320px,90vw)] rounded-[5px] border border-line bg-surface py-[9px] pl-[30px] pr-3 font-mono text-[13px] text-ink"
        />
        <span className="absolute left-[10px] top-[9px] text-[13px] text-muted">⌕</span>
      </div>
      <span className="text-[11.5px] text-muted">{note}</span>
    </div>
  );
}
