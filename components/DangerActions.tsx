'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { sendNewAddress, stopChasing, undoStopChasing } from '@/app/actions/parcel';
import { useToast } from './Toast';

/**
 * The two things that are never automated: a redirection, because Correos
 * charges for it, and writing a parcel off, because nothing brings it back.
 *
 * Both ask twice, in place. The confirmation lapses after four seconds so a
 * half-pressed button is not left armed for the next person who walks past.
 */
export function DangerActions({
  shipmentId, dropped, canRedirect,
}: { shipmentId: string; dropped: boolean; canRedirect: boolean }) {
  const [armed, setArmed] = useState<'redirect' | 'drop' | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  if (dropped) {
    return (
      <div className="rounded-[5px] border border-line bg-surface2 px-4 py-3 text-[12.5px] text-muted">
        We stopped chasing this one.{' '}
        <button
          type="button"
          className="font-semibold text-navy underline"
          onClick={() => start(async () => { await undoStopChasing(shipmentId); router.refresh(); })}
        >
          Start chasing it again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-[7px]">
      {canRedirect && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (armed !== 'redirect') { setArmed('redirect'); return; }
            start(async () => {
              const r = await sendNewAddress(shipmentId);
              setArmed(null); toast({ text: r.toast }); router.refresh();
            });
          }}
          className="rounded border border-warn px-4 py-[13px] text-[13px] font-semibold text-warn disabled:opacity-60"
          style={{ background: armed === 'redirect' ? 'var(--warnsoft)' : 'transparent' }}
        >
          {armed === 'redirect' ? 'Tap again — Correos charges' : 'Send to a new address'}
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (armed !== 'drop') { setArmed('drop'); return; }
          start(async () => {
            const r = await stopChasing(shipmentId);
            setArmed(null);
            toast({ text: r.toast, undo: async () => { await undoStopChasing(shipmentId); router.refresh(); } });
            router.refresh();
          });
        }}
        className="rounded border border-crit px-4 py-[13px] text-[13px] font-semibold text-crit disabled:opacity-60"
        style={{ background: armed === 'drop' ? 'var(--critsoft)' : 'transparent' }}
      >
        {armed === 'drop' ? 'Tap again — write it off' : 'Stop chasing this one'}
      </button>
    </div>
  );
}
