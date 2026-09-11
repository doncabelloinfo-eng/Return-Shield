import Link from 'next/link';
import type { ShipmentRow } from '@/lib/views/rows';
import { HeroNumber, PayBadge, toneColour } from './ui';
import { ActionButton } from './RowActions';
import { CopyButton } from './CopyButton';
import { STATE_LABEL } from '@/lib/carriers/correos/state-map';

/**
 * The one parcel that matters most, and the one thing to do about it.
 *
 * Everything on this card is here because it is needed to act without opening
 * anything else: the number, who it is, what is at risk, why it is top, what
 * happened last time, and the phone number big enough to dial from a metre away.
 */
export function FocusCard({ row, nextIndex, total }: { row: ShipmentRow; nextIndex: number; total: number }) {
  return (
    <div
      className="mt-4 rounded-md border border-line bg-surface p-5 shadow-focus"
      style={{ borderLeft: `5px solid ${toneColour(row.countdownTone)}` }}
    >
      <div className="flex flex-wrap items-start gap-[26px]">
        <div className="min-w-[120px] flex-none">
          <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">Deadline</div>
          <HeroNumber value={row.countdown} tone={row.countdownTone} size={72} />
          <div className="text-[12.5px] font-medium text-muted" title={row.exactWhen}>
            {row.officeDeadline && row.state === 'at_office'
              ? `goes back ${row.when}`
              : (STATE_LABEL[row.state] ?? row.state)}
          </div>
        </div>

        <div className="min-w-[230px] flex-1">
          <div className="flex flex-wrap items-center gap-[9px]">
            <span className="font-display text-[21px] font-bold text-ink">{row.customerName}</span>
            <PayBadge method={row.paymentMethod} />
          </div>
          <div className="mt-[6px] text-[13px] leading-[1.5] text-muted">
            {row.orderNumber} · {row.storeName} · {row.valueText}
            <br />
            {row.officeName && (
              <a href={row.mapsHref} target="_blank" rel="noreferrer" className="border-b border-line text-ink">
                {row.officeName} · {row.officeAddress}
              </a>
            )}
          </div>
          <div className="mt-[7px] inline-block rounded border border-line bg-surface2 px-[9px] py-[6px] text-[12.5px] font-medium text-ink">
            {row.topReason}
          </div>
          <div className="mt-[7px] text-[12.5px] text-muted">{row.lastContactLine}</div>
        </div>

        <div className="flex min-w-[210px] flex-none flex-col gap-[7px]">
          <ActionButton shipmentId={row.id} action={row.action} big />

          {row.phoneE164 ? (
            <a
              href={row.telHref}
              className="flex items-center justify-center gap-[7px] rounded border border-line bg-surface px-[14px] py-[11px] font-mono text-[13px] font-semibold text-ink"
            >
              {row.phoneDisplay}
            </a>
          ) : (
            <span className="rounded border border-warn bg-warnsoft px-[14px] py-[11px] text-center text-[12px] font-semibold text-warn">
              No phone number on this order
            </span>
          )}

          <div className="flex gap-[7px]">
            <CopyButton
              text={row.messageText}
              said="Message copied — paste it into WhatsApp."
              className="flex-1 rounded border border-line bg-surface px-3 py-[10px] text-[12px] font-semibold text-ink"
            >
              Copy message
            </CopyButton>
            {row.waHref && (
              <a
                href={row.waHref}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded border border-good bg-goodsoft px-3 py-[10px] text-center text-[12px] font-semibold text-good"
              >
                Open WhatsApp
              </a>
            )}
          </div>

          <div className="flex gap-[7px]">
            <Link
              href={`/parcel/${row.id}`}
              className="flex-1 rounded border border-line bg-surface2 px-3 py-[9px] text-center text-[12px] font-semibold text-ink"
            >
              Open parcel
            </Link>
            {total > 1 && (
              <Link
                href={`/today?focus=${nextIndex}`}
                className="flex-1 rounded bg-navy px-3 py-[9px] text-center text-[12px] font-semibold text-white"
              >
                Next ›
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
