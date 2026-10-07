'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { restockMany } from '@/app/actions/parcel';
import { useToast } from './Toast';

/**
 * Same job for all of them, so it is one button rather than eleven.
 *
 * "Mark as", not "Put": this records the restock here and nothing else.
 * Shopify's inventory does not move, because the access token is
 * `read_orders` only, so a button reading "Put all back in stock" was
 * promising a stock movement nobody has wired up. The button is unchanged —
 * the record is genuinely useful, it is what clears the parcel off the Today
 * screen — only its label now says what it actually does.
 */
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
      Mark as back in stock
    </button>
  );
}
