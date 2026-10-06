'use client';

import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Paging, in the URL, keeping the tab and the search.
 *
 * It says which rows you are looking at out of how many rather than only
 * offering arrows, because "1–100 of 342" is the answer to a question the
 * operator actually has: whether what they are looking at is all of it.
 */
export function Pager({
  page, pages, total, pageSize, path = '/parcels',
}: { page: number; pages: number; total: number; pageSize: number; path?: string }) {
  const router = useRouter();
  const params = useSearchParams();

  if (pages <= 1) {
    return (
      <div className="px-[14px] py-[10px] text-[12px] text-muted">
        {total === 0 ? 'Nothing here.' : `All ${total} of them.`}
      </div>
    );
  }

  const go = (p: number) => {
    const next = new URLSearchParams(params.toString());
    if (p <= 1) next.delete('page');
    else next.set('page', String(p));
    router.replace(`${path}${next.toString() ? `?${next}` : ''}`);
  };

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const button = 'rounded border border-line bg-surface px-[11px] py-[7px] text-[12px] font-semibold text-ink disabled:opacity-40';

  return (
    <div className="flex flex-wrap items-center gap-[8px] px-[14px] py-[10px]">
      <span className="text-[12px] text-muted">{from}–{to} of {total}</span>
      <span className="ml-auto flex gap-[6px]">
        <button type="button" className={button} disabled={page <= 1} onClick={() => go(page - 1)}>
          Previous
        </button>
        <span className="px-1 py-[7px] text-[12px] text-muted">Page {page} of {pages}</span>
        <button type="button" className={button} disabled={page >= pages} onClick={() => go(page + 1)}>
          Next
        </button>
      </span>
    </div>
  );
}
