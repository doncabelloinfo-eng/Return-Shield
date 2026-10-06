import Link from 'next/link';
import type { ParcelListRow } from '@/lib/views/parcels';
import { AlertBadge, Bilingual, Empty, PayBadge, Th } from './ui';

/**
 * Every parcel in the selected status, with enough on the row to deal with an
 * address problem without opening anything.
 *
 * That is why phone and town are columns rather than details: the two
 * questions this list gets asked are "where is it" and "who do I ring", and a
 * screen that answers the first and hides the second behind a click is half a
 * screen. Every cell the system could work out is worked out in
 * lib/views/parcels.ts — the table does no arithmetic.
 */
export function ParcelsTable({ rows, empty }: { rows: ParcelListRow[]; empty: React.ReactNode }) {
  if (!rows.length) return <div className="rounded-[5px] border border-line bg-surface">{empty}</div>;

  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>Shop</Th>
            <Th>Last word from Correos</Th>
            <Th>In this status</Th>
            <Th>Goes back</Th>
            <Th align="right">Value</Th>
            <Th>Phone</Th>
            <Th>Town</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top hover:bg-hover">
              <td className="border-b border-line px-3 py-[10px]">
                <Link href={`/parcel/${r.id}`} className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline">
                  {r.orderNumber}
                </Link>
                <div className="text-[12.5px] text-muted">{r.customerName}</div>
                {r.badges.length > 0 && (
                  <div className="mt-[5px] flex flex-wrap gap-[4px]">
                    {r.badges.map((b) => <AlertBadge key={b}>{b}</AlertBadge>)}
                  </div>
                )}
                {r.closed && (
                  <div className="mt-[5px] text-[11.5px] text-muted">
                    Closed {r.closed.at} · {r.closed.reason}
                    {r.closed.note ? ` — "${r.closed.note}"` : ''}
                  </div>
                )}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px] text-muted">
                {r.storeName}
              </td>

              <td className="min-w-[230px] border-b border-line px-3 py-[10px]">
                {r.event ? (
                  <>
                    <Bilingual en={r.event.en} es={r.event.es} size={12.5} />
                    <div className="mt-[3px] font-mono text-[11px] text-muted" title={r.event.exactWhen}>
                      {r.event.when}
                    </div>
                  </>
                ) : (
                  <span className="text-[12.5px] text-muted">Correos has said nothing yet</span>
                )}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                <Bilingual en={r.status.en} es={r.status.es} size={12} />
                <div className="mt-[3px] text-[11.5px] text-muted">{r.inStatus}</div>
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px]">
                {r.deadline
                  ? <span className="text-ink" title={r.deadlineExact ?? undefined}>{r.deadline}</span>
                  : <span className="text-muted">—</span>}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-right">
                <div className="text-[13px] font-semibold text-ink tabular-nums">{r.valueText}</div>
                <PayBadge method={r.paymentMethod} />
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px]">
                {r.phoneE164
                  ? <a href={`tel:${r.phoneE164}`} className="font-mono text-ink">{r.phoneDisplay}</a>
                  : <span className="text-muted">{r.phoneDisplay}</span>}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px] text-muted">
                {r.town || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableEmpty({ children }: { children: React.ReactNode }) {
  return <Empty>{children}</Empty>;
}
