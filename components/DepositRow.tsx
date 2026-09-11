'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { markDepositConfirmed, setDepositDays } from '@/app/actions/settings';

/** One Correos service, and how long its office holds a parcel. */
export function DepositRow({
  productCode, days, confirmed, count,
}: { productCode: string; days: number; confirmed: boolean; count: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const change = (next: number) => start(async () => {
    await setDepositDays(productCode, next);
    router.refresh();
  });

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-line px-4 py-[14px]">
      <div className="min-w-[170px]">
        <div className="font-mono text-[13.5px] font-medium text-ink">{productCode}</div>
        <div className="text-[11.5px] text-muted">
          {count} {count === 1 ? 'parcel' : 'parcels'} on this service
        </div>
      </div>

      <div className="flex items-center overflow-hidden rounded border border-line">
        <button type="button" disabled={pending || days <= 1} onClick={() => change(days - 1)}
          aria-label={`One day fewer for ${productCode}`}
          className="h-[34px] w-[34px] bg-surface2 text-[15px] font-semibold text-ink disabled:opacity-40">−</button>
        <span className="tnum min-w-[52px] text-center font-display text-[17px] font-bold text-ink">{days}</span>
        <button type="button" disabled={pending || days >= 30} onClick={() => change(days + 1)}
          aria-label={`One day more for ${productCode}`}
          className="h-[34px] w-[34px] bg-surface2 text-[15px] font-semibold text-ink disabled:opacity-40">+</button>
      </div>

      <span className="text-[12.5px] text-muted">days waiting before it goes back</span>

      <label className="ml-auto flex cursor-pointer items-center gap-2 whitespace-nowrap text-[12px] font-semibold text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={pending}
          onChange={(e) => start(async () => {
            await markDepositConfirmed(productCode, e.target.checked);
            router.refresh();
          })}
        />
        {confirmed ? 'Confirmed with Correos' : 'Still a guess'}
      </label>
    </div>
  );
}
