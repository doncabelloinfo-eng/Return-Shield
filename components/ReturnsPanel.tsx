import Link from 'next/link';
import type { ReturnRow, ReturnsView } from '@/lib/views/returns';
import { RETURNS_LIMIT } from '@/lib/views/returns';
import { Bilingual, Empty, ScanBadge, Th } from './ui';
import { ReturnsSearch } from './ReturnsSearch';

/**
 * What the warehouse scanned coming back, in two sections.
 *
 * The split is the point. "From Return Shield" is a parcel we sent and can say
 * something about; "Not in Return Shield" is a box that arrived with a Correos
 * label and no order behind it — a return from before this system existed, or
 * one whose order the rolling thirty-day window removed before it came back.
 * Both need somebody to deal with them, and the second kind is the one a
 * single-list screen would quietly swallow.
 *
 * NO CUSTOMER DETAILS ANYWHERE. These rows are built from scans, which carry a
 * code, an order number and a shop and nothing else by design.
 */
export function ReturnsPanel({ view }: { view: ReturnsView }) {
  return (
    <div className="flex flex-col gap-[14px]">
      <ReturnsSearch
        value={view.q}
        note={`The last ${view.days} days of incoming scans, newest first. A parcel scanned in two batches appears once.`}
      />

      <Section
        title="From Return Shield"
        note="The scan matched a parcel we sent."
        count={view.mineTotal}
        rows={view.mine}
        empty={view.q
          ? 'No return with that number matched a parcel.'
          : 'Nothing has been scanned back in yet.'}
      >
        <Mine rows={view.mine} />
      </Section>

      <Section
        title="Not in Return Shield"
        note="Nothing matched: from before Return Shield, or the order had already been cleaned up."
        count={view.theirsTotal}
        rows={view.theirs}
        empty={view.q
          ? 'No unmatched return with that number.'
          : 'Everything scanned back in matched a parcel.'}
      >
        <Theirs rows={view.theirs} />
      </Section>
    </div>
  );
}

function Section({
  title, note, count, rows, empty, children,
}: {
  title: string;
  note: string;
  count: number;
  rows: ReturnRow[];
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-[10px]">
        <h2 className="m-0 font-display text-[14px] font-bold text-ink">{title}</h2>
        <span className="tnum text-[13px] font-bold text-muted">{count}</span>
        <span className="text-[11.5px] text-muted">{note}</span>
      </div>

      <div className="mt-[7px]">
        {rows.length === 0 ? (
          <div className="rounded-[5px] border border-line bg-surface"><Empty>{empty}</Empty></div>
        ) : children}
      </div>

      {count > rows.length && (
        <div className="mt-[6px] text-[11.5px] text-muted">
          The newest {RETURNS_LIMIT} of {count}. Use the search box to find one.
        </div>
      )}
    </section>
  );
}

function Mine({ rows }: { rows: ReturnRow[] }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>Where Correos says it is</Th>
            <Th>Left the warehouse</Th>
            <Th>Came back</Th>
            <Th>Code on the label</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top hover:bg-hover">
              <td className="border-b border-line px-3 py-[10px]">
                {r.shipmentId ? (
                  <Link
                    href={`/parcel/${r.shipmentId}`}
                    prefetch={false}
                    className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
                  >
                    {r.label?.lead ?? r.base}
                  </Link>
                ) : (
                  <span className="text-[13px] font-semibold text-ink">{r.label?.lead ?? r.base}</span>
                )}
                <div className="text-[12.5px] text-muted">{r.label?.note ?? ''}</div>
              </td>

              <td className="min-w-[200px] border-b border-line px-3 py-[10px]">
                {r.status ? (
                  <Bilingual en={r.status.en} es={r.status.es} size={12.5} />
                ) : (
                  /*
                    The parcel itself has gone with the thirty-day window, and
                    the scan outlived it. Said plainly rather than left blank:
                    "we do not know" and "we never knew" are different answers
                    and only one of them means the return is a surprise.
                  */
                  <span className="text-[12.5px] text-muted">
                    Removed after 30 days — the return came back later
                  </span>
                )}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                {r.left
                  ? <ScanBadge mark={r.left} direction="outgoing" />
                  : <span className="text-[12.5px] text-muted">Never scanned out</span>}
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                <ScanBadge mark={r.back} direction="incoming" />
              </td>

              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[12.5px] text-ink">
                {r.base}
                {r.postalCode && <span className="text-muted"> · CP {r.postalCode}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Theirs({ rows }: { rows: ReturnRow[] }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Code on the label</Th>
            <Th>Postal code</Th>
            <Th>Came back</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-top hover:bg-hover">
              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[13px] font-medium text-ink">
                {r.base}
              </td>
              <td className="whitespace-nowrap border-b border-line px-3 py-[10px] font-mono text-[12.5px] text-muted">
                {r.postalCode ?? '—'}
              </td>
              <td className="whitespace-nowrap border-b border-line px-3 py-[10px]">
                <ScanBadge mark={r.back} direction="incoming" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
