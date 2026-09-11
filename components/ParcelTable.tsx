import Link from 'next/link';
import type { ShipmentRow } from '@/lib/views/rows';
import { HeroNumber, PayBadge, Th, toneColour } from './ui';
import { RowActions } from './RowActions';

/**
 * The list, in table form. One row per parcel, one decided next step per row.
 *
 * The left stripe and the weight of the number do the shouting, so the table
 * still reads correctly printed, in a screenshot, or by somebody who cannot
 * tell red from green.
 */
export function ParcelTable({
  rows, showOffice = false, empty,
}: { rows: ShipmentRow[]; showOffice?: boolean; empty: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table>
        <thead>
          <tr>
            <Th>Deadline</Th>
            <Th>Customer</Th>
            <Th align="right">At risk</Th>
            {showOffice && <Th>Post office</Th>}
            <Th>Next step</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const crit = r.countdownTone === 'crit' || r.countdownTone === 'ret';
            return (
              <tr
                key={r.id}
                style={{
                  background: r.countdownTone === 'ret' ? 'var(--retbg)'
                    : r.countdownTone === 'crit' ? 'var(--critsoft)' : 'transparent',
                }}
              >
                <td
                  className="border-b border-line align-middle"
                  style={{
                    padding: 'var(--rowpad)',
                    borderLeft: `4px solid ${crit ? toneColour(r.countdownTone) : 'transparent'}`,
                  }}
                >
                  <HeroNumber value={r.countdown} tone={r.countdownTone} size={30} />
                  <div className="whitespace-nowrap text-[11px] text-muted" title={r.exactWhen}>{r.when}</div>
                </td>

                <td className="whitespace-nowrap border-b border-line text-[13.5px] font-medium text-ink" style={{ padding: 'var(--rowpad)' }}>
                  <Link href={`/parcel/${r.id}`} className="text-ink hover:text-crit">{r.customerName}</Link>
                  <div className="text-[11.5px] font-normal text-muted">{r.orderNumber} · {r.storeName}</div>
                </td>

                <td className="whitespace-nowrap border-b border-line text-right" style={{ padding: 'var(--rowpad)' }}>
                  <div className="tnum text-[13.5px] font-semibold text-ink">{r.valueText}</div>
                  <PayBadge method={r.paymentMethod} />
                </td>

                {showOffice && (
                  <td className="border-b border-line text-[12.5px] text-ink" style={{ padding: 'var(--rowpad)' }}>
                    <a href={r.mapsHref} target="_blank" rel="noreferrer" className="text-ink">{r.officeName ?? '—'}</a>
                    <div className="text-[11.5px] text-muted">{r.town}</div>
                  </td>
                )}

                <td className="border-b border-line text-[12.5px] text-muted" style={{ padding: 'var(--rowpad)' }}>
                  {r.why}
                </td>

                <td className="relative whitespace-nowrap border-b border-line text-right" style={{ padding: 'var(--rowpad)' }}>
                  <RowActions
                    shipmentId={r.id}
                    action={r.action}
                    messageText={r.messageText}
                    shippingCode={r.shippingCode}
                    mapsHref={r.mapsHref}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && empty}
    </div>
  );
}
