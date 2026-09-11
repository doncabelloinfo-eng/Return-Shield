'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { Tone } from '@/lib/escalation/decide';
import { CALL_OUTCOMES } from '@/lib/escalation/outcome-names';
import { fileCallOutcome } from '@/app/actions/parcel';
import { HeroNumber, PayBadge, toneColour } from './ui';
import { CopyButton } from './CopyButton';
import { useToast } from './Toast';

export interface CallCard {
  id: string;
  customerName: string;
  paymentMethod: 'prepaid' | 'cod';
  phoneDisplay: string;
  phoneE164: string | null;
  telHref: string;
  waHref: string;
  mapsHref: string;
  messageText: string;
  valueText: string;
  countdown: string;
  countdownTone: Tone;
  daysLeftNumber: number | null;
  officeLine: string;
  lastContactLine: string;
}

/**
 * The keyboard is the interface here. Somebody working a list of twenty calls
 * has a phone in one hand; reaching for a mouse between each one is the
 * difference between finishing the list and not.
 *
 * Shortcuts are ignored while a note is being typed — otherwise typing "no
 * answer" into the note would file four outcomes and call somebody.
 */
export function CallList({ rows }: { rows: CallCard[] }) {
  const [focus, setFocus] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  const current = rows.length ? rows[focus % rows.length] : null;

  const file = useCallback((card: CallCard, outcome: string) => {
    start(async () => {
      const r = await fileCallOutcome(card.id, outcome, notes[card.id] ?? '');
      setNotes((n) => ({ ...n, [card.id]: '' }));
      toast({ text: r.toast });
      router.refresh();
    });
  }, [notes, router, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!current) return;

      const k = e.key.toLowerCase();
      if (k === 'c') {
        if (current.telHref) { e.preventDefault(); window.location.href = current.telHref; }
      } else if (k === 'n') {
        e.preventDefault();
        setFocus((f) => f + 1);
      } else if (['1', '2', '3', '4'].includes(k)) {
        e.preventDefault();
        file(current, CALL_OUTCOMES[Number(k) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, file]);

  useEffect(() => {
    if (!rows.length) return;
    cardRefs.current[focus % rows.length]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus, rows.length]);

  if (!rows.length) {
    return (
      <div className="max-w-[1000px] rounded-[5px] border border-line border-l-4 border-l-good bg-surface p-[22px]">
        <div className="font-display text-[15px] font-bold text-good">No calls owed.</div>
        <div className="mt-1 text-[13px] text-muted">
          Anyone who goes quiet will show up here.
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[1000px] flex-col gap-[11px]">
      {rows.map((r, i) => {
        const on = i === focus % rows.length;
        return (
          <div
            key={r.id}
            ref={(el) => { cardRefs.current[i] = el; }}
            className={`rounded-[5px] border border-line bg-surface px-[18px] py-4 ${on ? 'shadow-card outline outline-2 outline-accent' : ''}`}
            style={{ borderLeft: `4px solid ${r.countdownTone === 'calm' ? 'var(--line)' : toneColour(r.countdownTone)}` }}
          >
            <div className="flex flex-wrap items-center gap-[18px]">
              <div className="flex-none basis-[74px] text-center">
                <HeroNumber value={r.countdown} tone={r.countdownTone} size={44} />
                <div className="text-[9px] font-semibold uppercase tracking-[.09em] text-muted">
                  {r.daysLeftNumber === 1 ? 'day left' : 'days left'}
                </div>
              </div>
              <div className="w-px self-stretch bg-line" />

              <div className="min-w-[190px] flex-1">
                <div className="flex flex-wrap items-center gap-[9px]">
                  <span className="font-display text-[17px] font-semibold text-ink">{r.customerName}</span>
                  <PayBadge method={r.paymentMethod} />
                </div>
                {r.officeLine && (
                  <div className="mt-1 text-[12.5px] text-muted">
                    <a href={r.mapsHref} target="_blank" rel="noreferrer" className="text-muted">{r.officeLine}</a>
                  </div>
                )}
                <div className="mt-1 text-[12px] text-muted">{r.lastContactLine}</div>
              </div>

              <div className="min-w-[140px] flex-none text-right">
                {r.phoneE164 ? (
                  <a href={r.telHref} className="tnum block font-mono text-[clamp(17px,2vw,22px)] font-semibold text-ink">
                    {r.phoneDisplay}
                  </a>
                ) : (
                  <span className="text-[13px] font-semibold text-warn">No number on file</span>
                )}
                <div className="tnum mt-[3px] text-[12.5px] font-medium text-muted">{r.valueText} at risk</div>
              </div>
            </div>

            <div className="mt-[14px] border-t border-dashed border-line pt-[14px]">
              <div className="flex flex-wrap items-center gap-[7px]">
                {CALL_OUTCOMES.map((o, k) => (
                  <button
                    key={o}
                    type="button"
                    disabled={pending}
                    onClick={() => file(r, o)}
                    className="rounded border px-[13px] py-[10px] text-[12.5px] font-semibold disabled:opacity-60"
                    style={{
                      borderColor: k === 0 ? 'var(--good)' : k === 3 ? 'var(--crit)' : 'var(--line)',
                      background: 'var(--surface)',
                      color: k === 0 ? 'var(--good)' : k === 3 ? 'var(--crit)' : 'var(--ink)',
                    }}
                  >
                    {k + 1} · {o}
                  </button>
                ))}
                <CopyButton
                  text={r.messageText}
                  said="Message copied — paste it into WhatsApp."
                  className="ml-auto rounded border border-line bg-surface px-3 py-[9px] text-[12px] font-semibold text-ink"
                >
                  Copy message
                </CopyButton>
                {r.waHref && (
                  <a href={r.waHref} target="_blank" rel="noreferrer"
                    className="rounded border border-good bg-goodsoft px-3 py-[9px] text-[12px] font-semibold text-good">
                    WhatsApp
                  </a>
                )}
                <Link href={`/parcel/${r.id}`}
                  className="rounded border border-line bg-surface2 px-3 py-[9px] text-[12px] font-semibold text-ink">
                  Open parcel
                </Link>
              </div>

              <textarea
                rows={1}
                value={notes[r.id] ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                placeholder="Note (optional) — only if they said something worth remembering"
                className="mt-[9px] w-full resize-y rounded border border-line bg-surface px-[11px] py-[9px] text-[12.5px] leading-[1.5] text-ink"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
