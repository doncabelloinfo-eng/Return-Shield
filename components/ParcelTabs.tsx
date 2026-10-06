'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { TabCount } from '@/lib/views/parcels';

/**
 * One tab per status, with its count, in the order a parcel lives through them.
 *
 * The selected tab lives in the URL rather than in component state, the way
 * the Post office filters do — so a list can be sent to somebody, and so
 * refreshing after closing a parcel does not throw away what was being looked
 * at. Changing tabs clears the page number and keeps the search.
 *
 * Every tab shows even at zero. A tab that disappears when empty means the
 * operator cannot tell "nothing is stuck in pre-admission" from "this screen
 * does not know about pre-admission", and the first is worth seeing.
 */
export function ParcelTabs({ tabs, current }: { tabs: TabCount[]; current: string }) {
  const router = useRouter();
  const params = useSearchParams();

  const go = useCallback((id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('status', id);
    // A tab change starts at the beginning. Page 4 of one status is rarely
    // page 4 of the next, and landing on an empty page reads as a bug.
    next.delete('page');
    router.replace(`/parcels?${next}`);
  }, [params, router]);

  return (
    <div className="flex flex-wrap gap-[5px]">
      {tabs.map((t) => {
        const on = t.id === current;
        const loud = Boolean(t.urgent) && t.count > 0;

        return (
          <button
            key={t.id}
            type="button"
            onClick={() => go(t.id)}
            aria-current={on ? 'page' : undefined}
            className="rounded-[5px] border px-[10px] py-[6px] text-left"
            style={{
              borderColor: on ? 'var(--navy)' : loud ? 'var(--crit)' : 'var(--line)',
              background: on ? 'var(--navy)' : loud ? 'var(--critsoft)' : 'var(--surface)',
            }}
          >
            <span className="flex items-baseline gap-[6px]">
              <span
                className="text-[12px] font-semibold"
                style={{ color: on ? '#fff' : loud ? 'var(--crit)' : 'var(--ink)' }}
              >
                {t.en}
              </span>
              <span
                className="text-[12px] font-bold tabular-nums"
                style={{ color: on ? '#fff' : loud ? 'var(--crit)' : 'var(--muted)' }}
              >
                {t.count}
              </span>
            </span>
            {t.es ? (
              <span
                className="block text-[10.5px] italic"
                style={{ color: on ? 'rgba(255,255,255,.75)' : 'var(--muted)' }}
              >
                {t.es}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
