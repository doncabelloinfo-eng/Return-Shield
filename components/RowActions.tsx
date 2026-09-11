'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { NextAction } from '@/lib/escalation/decide';
import { useToast } from './Toast';
import {
  askCorreosAbout, confirmAddressNow, restockParcel, sendNewAddress,
  stopChasing, undoRestockParcel, undoStopChasing,
} from '@/app/actions/parcel';

/**
 * One decided action per row, plus everything else behind the ⋯.
 *
 * Two things here are deliberate and neither is decoration:
 *   · anything that spends money or cannot be undone asks twice, in place —
 *     the button becomes "Tap again to confirm" rather than opening a dialog
 *     that gets clicked through without reading;
 *   · the confirmation resets after four seconds, so a half-pressed button
 *     does not sit there waiting to fire the next time somebody taps near it.
 */

export interface RowActionProps {
  shipmentId: string;
  action: NextAction | null;
  messageText: string;
  shippingCode: string;
  mapsHref: string;
  big?: boolean;
}

const CONFIRM_TIMEOUT = 4000;

export function RowActions(props: RowActionProps) {
  const { shipmentId, action, big = false } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menuOpen]);

  return (
    <div ref={wrap} className="relative flex items-center justify-end gap-[6px]">
      <ActionButton shipmentId={shipmentId} action={action} big={big} />
      <button
        type="button"
        aria-label="More options"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className="h-7 w-7 rounded border border-line bg-surface text-[13px] font-bold text-muted"
      >
        ⋯
      </button>
      {menuOpen && <MoreMenu {...props} onDone={() => setMenuOpen(false)} />}
    </div>
  );
}

export function ActionButton({
  shipmentId, action, big = false,
}: { shipmentId: string; action: NextAction | null; big?: boolean }) {
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT);
    return () => clearTimeout(t);
  }, [armed]);

  if (!action) {
    return (
      <span className={`${big ? 'px-4 py-[13px] text-[13px]' : 'px-3 py-2 text-[12px]'} rounded border border-line bg-surface2 font-medium text-muted`}>
        Nothing to do
      </span>
    );
  }

  const run = () => {
    if (action.needsConfirm && !armed) { setArmed(true); return; }
    start(async () => {
      const result = await perform(shipmentId, action);
      setArmed(false);
      if (result?.toast) toast({ text: result.toast, undo: result.undo });
      router.refresh();
    });
  };

  const showConfirm = action.needsConfirm && armed;
  const tone = showConfirm ? 'confirm' : action.tone;

  return (
    <button
      type="button"
      onClick={run}
      disabled={pending}
      className={[
        'whitespace-nowrap rounded font-semibold disabled:opacity-60',
        big ? 'px-4 py-[13px] text-[13.5px]' : 'px-3 py-2 text-[12px]',
        tone === 'confirm' ? 'border border-warn bg-warnsoft text-warn font-bold'
          : tone === 'warn' ? 'border border-warn bg-surface text-warn'
          : 'border-none bg-navy text-white font-bold',
      ].join(' ')}
    >
      {showConfirm ? 'Tap again to confirm' : action.label}
    </button>
  );
}

async function perform(shipmentId: string, action: NextAction):
Promise<{ toast: string; undo?: () => Promise<void> } | null> {
  switch (action.kind) {
    case 'restock': {
      const r = await restockParcel(shipmentId);
      return { toast: r.toast, undo: async () => { await undoRestockParcel(shipmentId); } };
    }
    case 'send_redirect':
      return await sendNewAddress(shipmentId);
    case 'chase_carrier':
    case 'rebook_delivery':
      return await askCorreosAbout(shipmentId);
    case 'confirm_address':
      return await confirmAddressNow(shipmentId);
    case 'go_to_calls':
      window.location.href = '/calls';
      return null;
  }
}

function MoreMenu({
  shipmentId, messageText, shippingCode, mapsHref, onDone,
}: RowActionProps & { onDone: () => void }) {
  const [armedDrop, setArmedDrop] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const copy = async (text: string, said: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked; the text is still on screen */ }
    toast({ text: said });
    onDone();
  };

  const item = 'block w-full border-none border-b border-line bg-surface px-3 py-[10px] text-left text-[12.5px] font-medium text-ink hover:bg-hover';

  return (
    <div className="absolute right-0 top-[38px] z-20 min-w-[210px] overflow-hidden rounded-[5px] border border-line bg-surface text-left shadow-menu">
      <a href={`/parcel/${shipmentId}`} className={item}>Open parcel</a>
      <button type="button" className={item}
        onClick={() => copy(messageText, 'Message copied — paste it into WhatsApp.')}>
        Copy the message
      </button>
      <button type="button" className={item}
        onClick={() => copy(shippingCode, `Code ${shippingCode} copied.`)}>
        Copy the code
      </button>
      <a href={mapsHref} target="_blank" rel="noreferrer" className={item} onClick={onDone}>Open in maps</a>
      <button
        type="button"
        className={`${item} text-crit`}
        onClick={async () => {
          if (!armedDrop) { setArmedDrop(true); return; }
          const r = await stopChasing(shipmentId);
          toast({ text: r.toast, undo: async () => { await undoStopChasing(shipmentId); router.refresh(); } });
          onDone();
          router.refresh();
        }}
      >
        {armedDrop ? 'Tap again — stop chasing' : 'Stop chasing this one'}
      </button>
    </div>
  );
}
