'use client';

import { MADRID } from '@/lib/time';
import { DIRECTION_LABEL, type ScanDirection } from '@/lib/scan/model';
import type { BatchSummary } from '@/lib/scan/items';
import { WarnIcon } from './icons';
import { madridTime } from './BatchList';

/**
 * "Complete this batch?" — image 8.
 *
 * The three numbers are counted from the rows on screen by the same `summarise`
 * the server uses when the batch is finished, so the sheet and the saved batch
 * cannot disagree. See lib/scan/items.ts.
 *
 * FINISH WAITS FOR THE QUEUE. While anything is still being sent the button
 * says so and does nothing: a batch finished with reads still on the phone
 * would show the worker a total that is about to grow. The scans are not at
 * risk either way — they are on the phone and will arrive — but the number they
 * read before walking away has to be the real one.
 */
export function FinishSheet({
  direction,
  startedAt,
  summary,
  sending,
  busy,
  onKeepScanning,
  onFinish,
}: {
  direction: ScanDirection;
  startedAt: string;
  summary: BatchSummary;
  /** How many reads are still in the phone's queue. */
  sending: number;
  busy: boolean;
  onKeepScanning: () => void;
  onFinish: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Keep scanning"
        onClick={onKeepScanning}
        className="flex-1 bg-[rgba(6,10,20,.62)]"
      />

      <section
        aria-labelledby="finish-title"
        className="flex flex-col gap-4 rounded-t-[20px] bg-surface px-5 pb-7 pt-[10px] shadow-menu"
      >
        <span aria-hidden="true" className="h-1 w-10 self-center rounded-[2px] bg-line" />

        <div className="flex flex-col gap-1">
          <h2 id="finish-title" className="m-0 text-[22px] font-semibold tracking-[-.01em] text-ink">
            Complete this batch?
          </h2>
          <span className="font-mono text-[13px] text-muted">
            {DIRECTION_LABEL[direction]} · started {madridTime(startedAt)} · {madridDay(startedAt)}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Stat n={summary.scanned} what="parcels scanned" />
          <Stat n={summary.found} what="found in Return Shield" tone="good" />
          <Stat n={summary.notFound} what="not found" tone="warn" />
        </div>

        {summary.needsALook.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {summary.needsALook.slice(0, 4).map((row) => (
              <li
                key={row.base}
                className="flex items-start gap-3 rounded-[10px] border border-warn bg-warnsoft px-[14px] py-3"
              >
                <span className="mt-[2px] flex-none text-warn"><WarnIcon /></span>
                <span className="flex min-w-0 flex-col gap-[3px]">
                  <span className="font-mono text-[15px] font-medium text-ink">{row.base}</span>
                  <span className="text-[13px] leading-[1.45] text-warn">
                    {row.note === 'Not in Return Shield'
                      ? 'No order with this number in Return Shield. It stays in the batch so you can check the label later.'
                      : `${row.note}. Scan the barcode under Código de Bulto to say which one.`}
                  </span>
                </span>
              </li>
            ))}
            {summary.needsALook.length > 4 && (
              <li className="text-[13px] text-muted">
                and {summary.needsALook.length - 4} more
              </li>
            )}
          </ul>
        )}

        {sending > 0 && (
          <div className="rounded-[10px] border border-line bg-surface2 px-[14px] py-3 text-[13px] leading-[1.45] text-muted">
            {sending} {sending === 1 ? 'scan is' : 'scans are'} still being sent. They are saved on
            this phone — the batch can be finished as soon as they arrive.
          </div>
        )}

        <div className="grid grid-cols-2 gap-[10px]">
          <button
            type="button"
            onClick={onKeepScanning}
            className="flex h-[54px] items-center justify-center rounded-[10px] border border-line bg-surface text-[16px] font-semibold text-navy"
          >
            Keep scanning
          </button>
          <button
            type="button"
            onClick={onFinish}
            disabled={busy || sending > 0}
            className="flex h-[54px] items-center justify-center rounded-[10px] bg-navy text-[16px] font-semibold text-white disabled:opacity-40"
          >
            {sending > 0 ? 'Sending…' : busy ? 'Finishing…' : 'Finish batch'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Stat({ n, what, tone }: { n: number; what: string; tone?: 'good' | 'warn' }) {
  const box = tone === 'warn' ? 'border-warn bg-warnsoft' : 'border-line bg-surface';
  const num = tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div className={`flex flex-col gap-[2px] rounded-[10px] border px-3 py-[10px] ${box}`}>
      <span className={`tnum text-[28px] font-semibold leading-[1.1] ${num}`}>{n}</span>
      <span className="text-[12px] leading-[1.3] text-muted">{what}</span>
    </div>
  );
}

/** "Fri 16 Oct", in Madrid, whatever the phone's own zone is. */
export function madridDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      timeZone: MADRID,
    });
  } catch {
    return '';
  }
}
