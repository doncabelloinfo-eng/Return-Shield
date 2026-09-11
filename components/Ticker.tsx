import { fmt } from '@/lib/time';

/**
 * "What the system just did." It runs across the top of every screen so nobody
 * ever has to wonder whether the thing that was meant to happen on its own
 * actually happened.
 */
export function Ticker({ items }: { items: { id: number; at: Date; text: string }[] }) {
  return (
    <div className="flex items-start gap-3 border-b border-line bg-surface px-4 py-[9px]">
      <div className="min-w-[150px] flex-none pt-[2px] font-display text-[11.5px] font-bold text-ink">
        What the system just did
      </div>
      <div className="flex max-h-[74px] min-w-0 flex-1 flex-col gap-[3px] overflow-auto">
        {items.length === 0 && (
          <div className="text-[12.5px] text-muted">Nothing yet today.</div>
        )}
        {items.map((t, i) => (
          <div key={t.id} className="flex items-baseline gap-[10px]">
            <span className="flex-none basis-[96px] font-mono text-[11px] text-muted">
              {fmt(t.at).date} {fmt(t.at).time}
            </span>
            <span
              className="h-[6px] w-[6px] flex-none rounded-full"
              style={{ background: i === 0 ? 'var(--accent)' : 'var(--line)' }}
            />
            <span className="text-[12.5px] leading-[1.45] text-ink">{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
