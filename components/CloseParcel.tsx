'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CLOSE_REASONS, CLOSE_REASON_KEYS, noteRequiredFor, type CloseReason } from '@/lib/escalation/close-reasons';
import { stopChasing, undoStopChasing } from '@/app/actions/parcel';
import { useToast } from './Toast';

/**
 * "Stop chasing this one", with the reason it needs.
 *
 * Writing a parcel off used to be one tap-again button, which is the right
 * shape for an irreversible action and recorded nothing about why. A month
 * later a parcel Correos lost and a parcel the customer had all along were the
 * same row, and "how many did we lose, and to what" had no answer.
 *
 * So the second tap is now the reason itself. That keeps the two-step guard —
 * no single click writes a parcel off — without adding a step: picking a
 * reason IS the confirmation, which is better than a confirm dialog nobody
 * reads followed by a form.
 *
 * "Other" will not submit without a note, because "Other" with nothing
 * written is a row that records that somebody closed it and nothing else.
 */
export function CloseParcel({
  shipmentId, compact = false, onDone,
}: {
  shipmentId: string;
  /** In a list row: smaller type, no hints, fits in a ⋯ menu. */
  compact?: boolean;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<CloseReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const needsNote = reason !== null && noteRequiredFor(reason);
  const blocked = reason === null || (needsNote && !note.trim());

  function submit(): void {
    if (reason === null) { setError('Pick a reason first.'); return; }
    if (needsNote && !note.trim()) { setError('Say what happened — "Other" needs a note.'); return; }

    start(async () => {
      try {
        const r = await stopChasing(shipmentId, reason, note.trim());
        setOpen(false); setReason(null); setNote(''); setError(null);
        toast({
          text: r.toast,
          undo: async () => { await undoStopChasing(shipmentId); router.refresh(); },
        });
        onDone?.();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work.');
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={compact
          ? 'block w-full border-none border-b border-line bg-surface px-3 py-[10px] text-left text-[12.5px] font-medium text-crit hover:bg-hover'
          : 'rounded border border-crit px-4 py-[13px] text-[13px] font-semibold text-crit'}
      >
        Stop chasing this one
      </button>
    );
  }

  return (
    <div
      className={compact
        ? 'border-b border-line bg-surface2 px-3 py-[10px]'
        : 'rounded-[5px] border border-crit bg-surface px-[14px] py-3'}
      style={compact ? undefined : { background: 'var(--critsoft)' }}
    >
      <div className={`font-display font-bold text-crit ${compact ? 'text-[12px]' : 'text-[13px]'}`}>
        Why are you closing it?
      </div>
      {!compact && (
        <div className="mt-[3px] text-[12px] leading-[1.5] text-ink">
          Nothing brings the parcel back, and the reason is kept for good — it is
          what lets the system say how many parcels ended this way, and how.
        </div>
      )}

      <div className="mt-[9px] flex flex-col gap-[5px]">
        {CLOSE_REASON_KEYS.map((key) => {
          const on = reason === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => { setReason(key); setError(null); }}
              aria-pressed={on}
              className={`rounded border px-[10px] py-[7px] text-left text-[12.5px] font-semibold ${
                on ? 'border-navy bg-navy text-white' : 'border-line bg-surface text-ink'
              }`}
            >
              {CLOSE_REASONS[key].label}
              {!compact && (
                <span className={`ml-2 text-[11.5px] font-normal ${on ? 'text-white' : 'text-muted'}`}>
                  {CLOSE_REASONS[key].hint}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <input
        value={note}
        onChange={(e) => { setNote(e.target.value); setError(null); }}
        placeholder={needsNote ? 'What happened? (required)' : 'Note (optional)'}
        aria-label="Note"
        className="mt-[9px] w-full rounded-[5px] border border-line bg-surface px-[10px] py-[8px] text-[12.5px] text-ink"
        style={needsNote && !note.trim() ? { borderColor: 'var(--crit)' } : undefined}
      />

      {error && <div className="mt-[6px] text-[12px] font-semibold text-crit">{error}</div>}

      <div className="mt-[9px] flex flex-wrap gap-[6px]">
        <button
          type="button"
          onClick={submit}
          disabled={pending || blocked}
          className="rounded border border-crit px-[13px] py-[9px] text-[12.5px] font-semibold text-white disabled:opacity-50"
          style={{ background: 'var(--crit)' }}
        >
          {pending ? 'Closing…' : 'Close it'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setReason(null); setNote(''); setError(null); }}
          className="rounded border border-line bg-surface px-[13px] py-[9px] text-[12.5px] font-semibold text-ink"
        >
          Keep chasing it
        </button>
      </div>
    </div>
  );
}
