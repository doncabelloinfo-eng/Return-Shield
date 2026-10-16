'use client';

import { MADRID } from '@/lib/time';
import { unmatchedNote, type ScanLabel } from '@/lib/scan/items';
import { CrossIcon } from './icons';

/**
 * "This batch, newest first" — the list on images 3 to 6.
 *
 * One row per parcel, and the only four things a warehouse needs on it: the
 * 15-character number in mono, what it matched, the postcode printed on the
 * label and the time. NO CUSTOMER NAME, PHONE OR ADDRESS — the Scanner is never
 * sent them, so there is nothing here to leave on a shelf.
 *
 * The × removes a row with no dialog, by the operator's own instruction. That
 * is safe because undoing it costs one scan, and because a `confirm()` box on a
 * phone held in one hand is a tap people learn to dismiss without reading.
 */

export type RemoveTarget =
  | { kind: 'scan'; id: string }
  | { kind: 'read'; readId: string };

export interface DisplayRow {
  key: string;
  /** The 15-character base, which is what the warehouse reads back. */
  base: string;
  postalCode: string | null;
  /** ISO. Shown as Madrid time, whatever the phone's own zone is. */
  at: string;
  label: ScanLabel | null;
  sharing: number;
  timesRead: number;
  /** Still in the queue: on the phone, not yet on the server. */
  sending: boolean;
  justNow: boolean;
  remove: RemoveTarget;
}

/**
 * Madrid time, not the phone's.
 *
 * A handset bought abroad, or one that lost its zone, would otherwise put a
 * batch an hour out from everything the operator sees in the panel — and the
 * two are compared, parcel by parcel, when something has gone missing.
 */
export function madridTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: MADRID,
    });
  } catch {
    return '';
  }
}

export function BatchList({
  rows,
  onRemove,
}: {
  rows: DisplayRow[];
  onRemove: (target: RemoveTarget) => void;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-[10px] border border-dashed border-line bg-surface px-[14px] py-5 text-[13.5px] leading-[1.5] text-muted">
        Nothing scanned yet. Fill the box above with the barcode under
        {' '}
        <b className="text-ink">Código de Bulto</b>.
      </div>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.map((row) => <Item key={row.key} row={row} onRemove={onRemove} />)}
    </ul>
  );
}

function Item({ row, onRemove }: { row: DisplayRow; onRemove: (t: RemoveTarget) => void }) {
  const twice = row.timesRead > 1;
  const missing = row.label === null;

  // Just scanned wins over the rest: it is the row the worker is looking at.
  const skin = row.justNow
    ? 'border-good bg-goodsoft'
    : twice
      ? 'border-warn bg-warnsoft'
      : missing
        ? 'border-warn bg-warnsoft'
        : 'border-line bg-surface';

  return (
    <li className={`flex items-center gap-[10px] rounded-[10px] border py-[10px] pl-[14px] pr-2 ${skin}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[15px] font-medium text-ink">{row.base}</span>
          {row.justNow && (
            <span className="rounded-full bg-good px-2 text-[11px] font-bold text-white">Just now</span>
          )}
          {twice && (
            <span className="rounded-full border border-warn bg-surface px-2 text-[11px] font-bold text-warn">
              Scanned twice
            </span>
          )}
          {row.sending && (
            <span className="rounded-full border border-line bg-surface px-2 text-[11px] font-semibold text-muted">
              Sending…
            </span>
          )}
        </span>

        {row.label ? (
          <span className="truncate text-[13px] font-semibold text-ink">
            {row.label.lead}
            {row.label.note ? <span className="font-normal text-muted"> · {row.label.note}</span> : null}
          </span>
        ) : row.sending ? (
          // Nothing yet. The match is worked out on the server, and guessing
          // "Not in Return Shield" while a read is still in the queue would
          // flash a wrong answer at somebody holding the parcel it is about.
          null
        ) : (
          <span className="text-[13px] font-semibold text-warn">
            {unmatchedNote(row.sharing)}
          </span>
        )}

        <span className="font-mono text-[12px] text-muted">
          {row.postalCode ? `CP ${row.postalCode} · ` : ''}{madridTime(row.at)}
        </span>
      </div>

      <button
        type="button"
        onClick={() => onRemove(row.remove)}
        aria-label={`Remove ${row.base}`}
        className="grid h-11 w-11 flex-none place-items-center rounded-[8px] text-muted"
      >
        <CrossIcon />
      </button>
    </li>
  );
}
