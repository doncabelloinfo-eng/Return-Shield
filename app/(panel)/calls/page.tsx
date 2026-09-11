import { callsView } from '@/lib/views/rows';
import { CallList } from '@/components/CallList';
import { PageHeading } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Twenty calls without touching the mouse.
 *
 * C to call, N for next, 1–4 to file the outcome. Each outcome sets its own
 * follow-up, so filing a call never leaves a parcel with nothing scheduled.
 */
export default async function CallsPage() {
  const rows = await callsView();

  return (
    <div className="px-4 pb-10 pt-[18px]">
      <div className="mb-2 flex flex-wrap items-end gap-[14px]">
        <PageHeading
          title="Call list"
          note={rows.length
            ? `${rows.length} calls owed · most money at risk first · one tap files it and sets its own follow-up`
            : 'nothing owed'}
        />
        <div className="ml-auto font-mono text-[11.5px] text-muted">C call · N next · 1–4 outcome</div>
      </div>

      <CallList rows={rows.map((r) => ({
        id: r.id,
        customerName: r.customerName,
        paymentMethod: r.paymentMethod,
        phoneDisplay: r.phoneDisplay,
        phoneE164: r.phoneE164,
        telHref: r.telHref,
        waHref: r.waHref,
        mapsHref: r.mapsHref,
        messageText: r.messageText,
        valueText: r.valueText,
        countdown: r.countdown,
        countdownTone: r.countdownTone,
        daysLeftNumber: r.daysLeftNumber,
        officeLine: [r.officeName, r.officeAddress].filter(Boolean).join(' · '),
        lastContactLine: r.lastContactLine,
      }))} />
    </div>
  );
}
