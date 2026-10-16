'use client';

import Link from 'next/link';
import { DIRECTION_LABEL, type ScanDirection } from '@/lib/scan/model';
import type { BatchSummary } from '@/lib/scan/items';
import { TickIcon, WarnIcon } from './icons';
import { madridTime } from './BatchList';
import { madridDay } from './FinishSheet';

/**
 * "Batch saved" — image 9, and the last thing the warehouse sees before the
 * pile goes to Correos.
 *
 * The four lines are the ones the operator asked for: found, not found, typed
 * by hand, and scanned twice kept once. "Needs a look" repeats the codes
 * nothing matched, because this screen is the only chance to catch a label
 * worth re-reading while the parcel is still in the room.
 *
 * The numbers come from the SERVER's count of the batch it just closed, not
 * from the phone's — a batch is finished once, and what it says should be what
 * the panel will show.
 */
export function BatchSaved({
  direction,
  startedAt,
  finishedAt,
  summary,
  onNewBatch,
}: {
  direction: ScanDirection;
  startedAt: string;
  finishedAt: string | null;
  summary: BatchSummary;
  onNewBatch: () => void;
}) {
  const ended = finishedAt ?? new Date().toISOString();

  return (
    <main className="flex min-h-[100dvh] flex-col bg-ground">
      <header className="flex h-14 flex-none items-center justify-between bg-navy px-4 text-white">
        <div className="flex items-center gap-[10px]">
          <span className="h-3 w-3 rounded-[2px] bg-accent" />
          <span className="text-[18px] font-bold">Scanner</span>
        </div>
        <span className="rounded-[6px] border border-navy2 px-2 py-1 font-mono text-[12px] text-navmuted">
          {madridDay(ended)} · {madridTime(ended)}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-[18px] px-4 pt-7">
        <div className="flex flex-col items-center gap-[10px] text-center">
          <span className="grid h-[76px] w-[76px] place-items-center rounded-full bg-good text-white shadow-[0_0_0_8px_var(--goodsoft)]">
            <TickIcon size={34} width={3} />
          </span>
          <h1 className="mb-0 mt-[6px] text-[28px] font-semibold tracking-[-.015em] text-ink">
            Batch saved
          </h1>
          <span className="text-[15px] text-muted">
            <b className="text-ink">{summary.scanned}</b> {DIRECTION_LABEL[direction].toLowerCase()}{' '}
            {summary.scanned === 1 ? 'parcel' : 'parcels'}
          </span>
          <span className="font-mono text-[13px] text-muted">
            {madridTime(startedAt)} – {madridTime(ended)} · {minutesBetween(startedAt, ended)}
          </span>
        </div>

        <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
          <Row what="Found in Return Shield" n={summary.found} tone="good" />
          <Row what="Not found" n={summary.notFound} tone="warn" />
          <Row what="Typed by hand" n={summary.typed} />
          <Row what="Scanned twice, kept once" n={summary.scannedTwice} last />
        </div>

        {summary.needsALook.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[.09em] text-ink">
              Needs a look
            </span>
            {summary.needsALook.map((row) => (
              <div
                key={row.base}
                className="flex items-center gap-3 rounded-[10px] border border-warn bg-warnsoft px-[14px] py-3"
              >
                <span className="flex-none text-warn"><WarnIcon /></span>
                <span className="flex min-w-0 flex-col gap-[2px]">
                  <span className="font-mono text-[15px] font-medium text-ink">{row.base}</span>
                  <span className="text-[13px] text-warn">{row.note}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="flex flex-none flex-col gap-[10px] px-4 pb-7 pt-4">
        <button
          type="button"
          onClick={onNewBatch}
          className="flex h-14 items-center justify-center gap-[10px] rounded-[10px] bg-navy text-[17px] font-semibold text-white"
        >
          Start new batch
        </button>
        <Link
          href="/scan"
          className="flex h-[52px] items-center justify-center rounded-[10px] border border-line bg-surface text-[16px] font-semibold text-navy"
        >
          Switch outgoing / incoming
        </Link>
      </footer>
    </main>
  );
}

function Row({
  what, n, tone, last,
}: {
  what: string; n: number; tone?: 'good' | 'warn'; last?: boolean;
}) {
  const colour = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div
      className={`flex items-center justify-between px-4 py-[13px] text-[15px] text-ink ${last ? '' : 'border-b border-line'}`}
    >
      <span>{what}</span>
      <span className={`tnum font-semibold ${colour}`}>{n}</span>
    </div>
  );
}

/** "19 min", or "1 h 04 min" once a pile has taken that long. */
export function minutesBetween(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
