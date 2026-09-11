'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CALL_OUTCOMES } from '@/lib/escalation/outcome-names';
import { fileCallOutcome } from '@/app/actions/parcel';
import { Card, Chip } from './ui';
import { useToast } from './Toast';

export interface LogEntry {
  id: string; when: string; exact: string; outcome: string; note: string;
}

/** Calls and messages, and one tap to file the next one. */
export function FileCall({ shipmentId, log }: { shipmentId: string; log: LogEntry[] }) {
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const shown = expanded || log.length <= 3 ? log : log.slice(0, 3);

  return (
    <Card
      title="Calls and messages"
      note={log.length ? `${log.length} ${log.length === 1 ? 'try' : 'tries'} · last one ${log[0].when}` : 'never contacted'}
      action={log.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded border border-line bg-surface2 px-[9px] py-1 text-[11px] font-semibold text-muted"
        >
          {expanded ? 'Collapse' : `Show all ${log.length}`}
        </button>
      ) : undefined}
    >
      {shown.map((c) => (
        <div key={c.id} className="border-b border-line px-[14px] py-[11px]">
          <div className="flex flex-wrap items-center gap-[9px]">
            <span className="font-mono text-[11px] text-muted" title={c.exact}>{c.when}</span>
            <OutcomeChip outcome={c.outcome} />
          </div>
          {c.note && (
            <div className="mt-[5px] text-[12.5px] italic leading-[1.45] text-ink">“{c.note}”</div>
          )}
        </div>
      ))}

      <div className="flex flex-wrap gap-[6px] px-[14px] py-3">
        {CALL_OUTCOMES.map((o, i) => (
          <button
            key={o}
            type="button"
            disabled={pending}
            onClick={() => start(async () => {
              const r = await fileCallOutcome(shipmentId, o, note);
              setNote('');
              toast({ text: r.toast });
              router.refresh();
            })}
            className="rounded border px-3 py-[9px] text-[12px] font-semibold disabled:opacity-60"
            style={{
              borderColor: i === 0 ? 'var(--good)' : i === 3 ? 'var(--crit)' : 'var(--line)',
              background: 'var(--surface)',
              color: i === 0 ? 'var(--good)' : i === 3 ? 'var(--crit)' : 'var(--ink)',
            }}
          >
            {i + 1} · {o}
          </button>
        ))}
      </div>

      <div className="px-[14px] pb-3">
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note if they said something worth remembering (optional)"
          className="w-full resize-y rounded border border-line bg-surface2 px-[11px] py-[9px] text-[12.5px] leading-[1.5] text-ink"
        />
      </div>
    </Card>
  );
}

function OutcomeChip({ outcome }: { outcome: string }) {
  if (outcome === 'Will pick it up' || outcome === 'Customer replied') {
    return <Chip colour="var(--good)" background="var(--goodsoft)">{outcome}</Chip>;
  }
  if (outcome === "Doesn't want it") {
    return <Chip colour="var(--crit)" background="var(--critsoft)">{outcome}</Chip>;
  }
  return <Chip colour="var(--muted)" background="var(--surface2)">{outcome}</Chip>;
}
