import Link from 'next/link';
import type { ClosuresView } from '@/lib/views/closures';
import { ClosureFilters } from './ClosureFilters';
import { Pager } from './Pager';
import { Empty, Th } from './ui';

/**
 * Every parcel written off, with the counts per reason.
 *
 * Two numbers per reason, because they answer different questions: the window
 * says what is happening now, and all time says whether it is getting worse.
 * All time keeps counting after the parcel itself has gone — `closures` is the
 * one table the thirty-day cleanup never touches, which is the only reason
 * this screen can look back further than a month.
 */
export function ClosuresPanel({
  view, current,
}: {
  view: ClosuresView;
  current: { reason: string; store: string; month: string };
}) {
  return (
    <div className="flex flex-col gap-[14px]">
      <div className="rounded-[5px] border border-line bg-surface">
        <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-[14px] py-[11px]">
          <span className="font-display text-[11.5px] font-bold text-ink">Why parcels were closed</span>
          <span className="text-[11.5px] text-muted">
            {view.recentTotal} in the last {view.windowDays} days
            {view.recentTotal > 0 && <> · {view.recentValueText} written off</>}
            {' · '}{view.allTimeTotal} all time
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 px-[14px] py-[11px] sm:grid-cols-4">
          {view.counts.map((c) => (
            <div key={c.reason}>
              <div className="text-[11.5px] font-semibold text-ink">{c.label}</div>
              <div className="mt-[2px] flex items-baseline gap-[6px]">
                <span className="font-display text-[20px] font-bold leading-none text-ink tabular-nums">
                  {c.recent}
                </span>
                <span className="text-[11px] text-muted">
                  last {view.windowDays} days
                </span>
              </div>
              <div className="mt-[2px] text-[11px] text-muted tabular-nums">{c.allTime} all time</div>
            </div>
          ))}
        </div>

        <div className="border-t border-line px-[14px] py-[10px] text-[11.5px] leading-[1.5] text-muted">
          These records outlive their parcels. The nightly cleanup removes an order
          thirty days after it came in, and never touches this table — so the counts
          above still answer &ldquo;how many did we lose, and to what&rdquo; long after the
          parcel itself has gone.
        </div>
      </div>

      <ClosureFilters
        reasons={view.counts.map((c) => ({ id: c.reason, label: c.label }))}
        stores={view.stores}
        months={view.months}
        current={current}
      />

      <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
        {view.rows.length === 0 ? (
          <Empty good>No parcels have been written off{current.reason || current.store || current.month ? ' that match this' : ' yet'}.</Empty>
        ) : (
          <>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th>Shop</Th>
                  <Th>Reason</Th>
                  <Th align="right">Value</Th>
                  <Th>Days from order</Th>
                  <Th>Closed</Th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-hover">
                    <td className="border-b border-line px-3 py-[10px]">
                      {/* Null once the window has taken the parcel. The record stays. */}
                      {r.shipmentId ? (
                        <Link href={`/parcel/${r.shipmentId}`} className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline">
                          {r.orderNumber}
                        </Link>
                      ) : (
                        <span className="text-[13px] font-semibold text-ink">{r.orderNumber}</span>
                      )}
                      <div className="font-mono text-[11px] text-muted">{r.shippingCode}</div>
                      {!r.shipmentId && (
                        <div className="mt-[3px] text-[11px] text-muted">parcel cleaned up</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px] text-muted">
                      {r.storeName}
                    </td>
                    <td className="border-b border-line px-3 py-[10px]">
                      <div className="text-[12.5px] font-medium text-ink">{r.reasonLabel}</div>
                      {r.note && <div className="mt-[2px] text-[11.5px] italic text-muted">&ldquo;{r.note}&rdquo;</div>}
                    </td>
                    <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-right text-[13px] font-semibold text-ink tabular-nums">
                      {r.valueText}
                    </td>
                    <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px] text-muted tabular-nums">
                      {r.daysSinceOrder}
                    </td>
                    <td className="whitespace-nowrap border-b border-line px-3 py-[10px] text-[12.5px] text-muted" title={r.closedExact}>
                      {r.closedAt}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-line">
              <Pager page={view.page} pages={view.pages} total={view.total} pageSize={100} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
