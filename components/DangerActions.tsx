'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { sendNewAddress, undoStopChasing } from '@/app/actions/parcel';
import { closeReasonLabel } from '@/lib/escalation/close-reasons';
import { CloseParcel } from './CloseParcel';
import { useToast } from './Toast';

/**
 * The two things that are never automated: a redirection, because Correos
 * charges for it, and writing a parcel off, because nothing brings it back.
 *
 * Neither happens on one tap. The redirection asks twice in place, and the
 * confirmation lapses after four seconds so a half-pressed button is not left
 * armed for the next person who walks past. Writing a parcel off asks for a
 * reason instead, which is a better second step than a second tap: it cannot
 * be clicked through, and it leaves something behind.
 */
export function DangerActions({
  shipmentId, dropped, canRedirect, closeReason = null, closeNote = '',
}: {
  shipmentId: string;
  dropped: boolean;
  canRedirect: boolean;
  closeReason?: string | null;
  closeNote?: string;
}) {
  const [armed, setArmed] = useState<'redirect' | null>(null);
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
        We stopped chasing this one{closeReason ? `: ${closeReasonLabel(closeReason)}` : ''}.
        {closeNote ? <> &ldquo;{closeNote}&rdquo;</> : null}{' '}
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
    <div className="flex flex-col gap-[7px]">
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
      <CloseParcel shipmentId={shipmentId} />
    </div>
  );
}
