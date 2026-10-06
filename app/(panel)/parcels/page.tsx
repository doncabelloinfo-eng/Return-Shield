import { parcelsView, PAGE_SIZE } from '@/lib/views/parcels';
import { closuresView } from '@/lib/views/closures';
import { ParcelTabs } from '@/components/ParcelTabs';
import { ParcelSearch } from '@/components/ParcelSearch';
import { ParcelsTable } from '@/components/ParcelsTable';
import { ClosuresPanel } from '@/components/ClosuresPanel';
import { Pager } from '@/components/Pager';
import { PageHeading, Empty } from '@/components/ui';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Every parcel, by status. The screen that was missing.
 *
 * Today shows what needs doing and Post office shows what is being held, so a
 * parcel moving normally through Correos appeared on no screen at all —
 * eleven of them were tracked, correct and invisible. This answers "where is
 * everything", which is a different question from "what do I have to do".
 */
export default async function ParcelsPage({
  searchParams,
}: {
  searchParams: {
    status?: string; q?: string; store?: string; page?: number | string;
    reason?: string; month?: string;
  };
}) {
  const page = Number(searchParams.page ?? 1) || 1;
  const q = searchParams.q ?? '';
  const store = searchParams.store ?? '';

  const view = await parcelsView({ status: searchParams.status, q, store, page });
  const onClosed = view.tab.id === 'closed';

  // The closed tab is backed by `closures`, not by `shipments`: that table is
  // the one the thirty-day cleanup never touches, so it still has the
  // write-offs whose parcels have since gone.
  const closures = onClosed
    ? await closuresView({
      reason: searchParams.reason,
      store,
      month: searchParams.month,
      page,
    })
    : null;

  const heading = headingFor(view.tab.id, view.total, view.tabs);

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <div className="flex flex-wrap items-end gap-[14px]">
        <PageHeading title="Parcels" note={heading} />
        {!onClosed && (
          <ParcelSearch stores={view.stores} current={{ q, store }} />
        )}
      </div>

      <div className="mt-[14px]">
        <ParcelTabs tabs={view.tabs} current={view.tab.id} />
      </div>

      <div className="mt-[14px]">
        {onClosed && closures ? (
          <ClosuresPanel
            view={closures}
            current={{
              reason: searchParams.reason ?? '',
              store,
              month: searchParams.month ?? '',
            }}
          />
        ) : (
          <>
            <ParcelsTable
              rows={view.rows}
              empty={<Empty good>{emptyFor(view.tab.id, q || store)}</Empty>}
            />
            {view.rows.length > 0 && (
              <div className="mt-[2px] rounded-[5px] border border-line bg-surface">
                <Pager page={view.page} pages={view.pages} total={view.total} pageSize={PAGE_SIZE} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The line under the title: what this tab is, and what is worth knowing. */
function headingFor(
  tab: string,
  total: number,
  tabs: { id: string; count: number }[],
): string {
  const open = tabs.find((t) => t.id === 'all_open')?.count ?? 0;
  const stuckPre = tabs.find((t) => t.id === 'stuck_pre_admission')?.count ?? 0;
  const stuck30 = tabs.find((t) => t.id === 'stuck_30')?.count ?? 0;

  if (tab === 'stuck_pre_admission') {
    return `${total} with a label printed and nothing from Correos for two working days`
      + ' · weekends do not count';
  }
  if (tab === 'stuck_30') {
    return `${total} past the cleanup window and still going — these are kept until they finish`;
  }
  if (tab === 'closed') return 'Written off by hand. The record outlives the parcel.';

  const notes = [`${open} not finished yet`];
  if (stuckPre) notes.push(`${stuckPre} stuck in pre-admission`);
  if (stuck30) notes.push(`${stuck30} over 30 days`);
  return notes.join(' · ');
}

function emptyFor(tab: string, filtered: boolean | string): string {
  if (filtered) return 'Nothing in this status matches what you typed.';
  if (tab === 'stuck_pre_admission') return 'Nothing is stuck in pre-admission. Correos has taken everything.';
  if (tab === 'stuck_30') return 'Nothing is older than the cleanup window and still unfinished.';
  if (tab === 'to_review') return 'Correos has not said anything we do not recognise.';
  if (tab === 'all_open') return 'Every parcel is finished.';
  return 'Nothing in this status.';
}
