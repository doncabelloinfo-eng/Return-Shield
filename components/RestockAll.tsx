'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { restockMany } from '@/app/actions/parcel';
import { useToast } from './Toast';

/** Same job for all of them, so it is one button rather than eleven. */
export function RestockAll({ ids }: { ids: string[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => {
        const r = await restockMany(ids);
        toast({ text: r.toast });
        router.refresh();
      })}
      className="whitespace-nowrap rounded bg-navy px-[13px] py-[9px] text-[12px] font-semibold text-white disabled:opacity-60"
    >
      Put all back in stock
    </button>
  );
}
