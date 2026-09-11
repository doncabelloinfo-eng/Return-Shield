import Link from 'next/link';
import type { Tone } from '@/lib/escalation/decide';

/**
 * The small pieces every screen is made of. The prototype built these with
 * inline style strings; here they are components so a colour or a weight
 * changes in one place.
 */

/** The countdown. Weight and colour both carry the urgency, never colour alone. */
export function HeroNumber({ value, tone, size }: { value: string; tone: Tone; size: number }) {
  const cls = tone === 'ret' ? 'hero-ret' : tone === 'crit' ? 'hero-crit' : tone === 'warn' ? 'hero-warn' : 'hero-calm';
  return <div className={`hero-num ${cls}`} style={{ fontSize: `${size}px` }}>{value}</div>;
}

export function Chip({
  children, colour, background, className = '',
}: { children: React.ReactNode; colour: string; background: string; className?: string }) {
  return (
    <span
      className={`inline-block rounded-[3px] border px-[7px] py-[2px] text-[11px] font-semibold whitespace-nowrap ${className}`}
      style={{ borderColor: colour, background, color: colour }}
    >
      {children}
    </span>
  );
}

export function StateChip({ label, tone }: { label: string; tone: Tone }) {
  const colour = toneColour(tone);
  const bg = tone === 'calm' ? 'var(--surface2)' : tone === 'warn' ? 'var(--warnsoft)' : 'var(--critsoft)';
  return <Chip colour={colour} background={bg}>{label}</Chip>;
}

/**
 * Cash on delivery gets more weight than prepaid, everywhere, because it is
 * the difference between losing the margin and losing the whole sale.
 */
export function PayBadge({ method, long = false }: { method: 'prepaid' | 'cod'; long?: boolean }) {
  const cod = method === 'cod';
  const text = long ? (cod ? 'Cash on delivery' : 'Paid already') : (cod ? 'COD' : 'Prepaid');
  return (
    <span
      className="mt-[3px] inline-block rounded-[3px] border px-[6px] py-[2px] text-[10.5px] font-semibold whitespace-nowrap"
      style={{
        borderColor: cod ? 'var(--muted)' : 'var(--line)',
        background: 'var(--surface2)',
        color: cod ? 'var(--ink)' : 'var(--muted)',
      }}
    >
      {text}
    </span>
  );
}

export function toneColour(t: Tone): string {
  return t === 'calm' ? 'var(--ink)' : t === 'warn' ? 'var(--warn)' : 'var(--crit)';
}

export function Card({
  title, note, children, action,
}: { title?: string; note?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[5px] border border-line bg-surface">
      {title && (
        <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-[14px] py-[11px]">
          <span className="font-display text-[11.5px] font-bold text-ink">{title}</span>
          {note && <span className="text-[11.5px] text-muted">{note}</span>}
          {action && <span className="ml-auto">{action}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-[10px]">
      <h2 className="m-0 font-display text-[16px] font-bold text-ink">{title}</h2>
      {note && <span className="text-[12.5px] text-muted">{note}</span>}
    </div>
  );
}

export function PageHeading({ title, note }: { title: string; note?: React.ReactNode }) {
  return (
    <div>
      <h1 className="m-0 font-display text-[21px] font-bold text-ink">{title}</h1>
      {note && <div className="mt-1 text-[13px] text-muted">{note}</div>}
    </div>
  );
}

export function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className="whitespace-nowrap border-b border-line px-3 py-[9px] text-[10px] font-semibold uppercase tracking-[.09em] text-muted"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}

export function Empty({ children, good = false }: { children: React.ReactNode; good?: boolean }) {
  return (
    <div className={`p-[18px] text-[13.5px] ${good ? 'text-good' : 'text-muted'}`}>{children}</div>
  );
}

export function ParcelLink({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  return <Link href={`/parcel/${id}`} className={className}>{children}</Link>;
}
