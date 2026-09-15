import Link from 'next/link';
import { todayView } from '@/lib/views/rows';
import { ParcelTable } from '@/components/ParcelTable';
import { FocusCard } from '@/components/FocusCard';
import { RestockAll } from '@/components/RestockAll';
import { SectionHeading, Empty } from '@/components/ui';
import { money } from '@/lib/escalation/decide';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Open it with your coffee.
 *
 * One card at a time: the parcel that matters most, the one thing to do about
 * it, and Next. The order is money at risk and days left, and the card says
 * why it is top — nobody should have to work out the ordering themselves.
 */
export default async function TodayPage({
  searchParams,
}: { searchParams: { focus?: string } }) {
  const focusIndex = Number(searchParams.focus ?? 0) || 0;
  const view = await todayView(focusIndex);

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <h1 className="m-0 max-w-[900px] font-display text-[clamp(19px,2.1vw,26px)] font-semibold leading-[1.35] text-ink">
        {view.headline}
      </h1>

      <div className="mt-2 flex max-w-[820px] flex-col gap-[3px]">
        {view.digest.map((d) => (
          <div key={d} className="text-[13.5px] leading-[1.5] text-muted">{d}</div>
        ))}
      </div>

      <div className="mt-4 flex max-w-[820px] flex-wrap items-center gap-3">
        <div className="h-[6px] min-w-[180px] flex-1 overflow-hidden rounded bg-line">
          <span
            className="block h-full bg-good"
            style={{ width: `${view.totalToday ? Math.round((view.doneToday / view.totalToday) * 100) : 100}%` }}
          />
        </div>
        <span className="whitespace-nowrap text-[12.5px] font-medium text-muted">{view.progressLabel}</span>
      </div>

      {view.focus ? (
        <FocusCard row={view.focus} nextIndex={focusIndex + 1} total={view.rows.length} />
      ) : (
        <div className="mt-[18px] rounded-[5px] border border-line border-l-4 border-l-good bg-surface p-[22px]">
          <div className="font-display text-[16px] font-bold text-good">Nothing needs you right now.</div>
          <div className="mt-1 text-[13px] text-muted">
            Every parcel is either moving normally or already handled. The system will tell
            you when that changes.
          </div>
        </div>
      )}

      {view.comingBack.length > 1 && (
        <div className="mt-[22px]">
          <div className="flex flex-wrap items-center gap-3 rounded-[5px] border border-line border-l-4 border-l-crit bg-surface px-4 py-[14px]">
            <div className="min-w-[220px] flex-1">
              <div className="text-[14.5px] font-semibold text-ink">
                {view.comingBack.length} parcels coming back —{' '}
                {money(view.comingBack.reduce((a, s) => a + s.valueCents, 0))} total
              </div>
              <div className="mt-[3px] text-[12.5px] text-muted">
                Same job for all of them: log them back into stock as they land.
              </div>
            </div>
            <Link
              href="/office"
              className="whitespace-nowrap rounded border border-line bg-surface px-[13px] py-[9px] text-[12px] font-semibold text-ink"
            >
              See all
            </Link>
            <RestockAll ids={view.comingBack.map((r) => r.id)} />
          </div>
        </div>
      )}

      <div className="mt-[26px]">
        <SectionHeading
          title="Everything waiting on you"
          note={view.rows.length ? 'most money at risk first · one decided step each' : 'nothing owed'}
        />
      </div>

      <div className="mt-[10px]">
        <ParcelTable
          rows={view.rows}
          empty={<Empty>Nothing waiting on you. Good morning.</Empty>}
        />
      </div>
    </div>
  );
}
