import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { contactLog, shipmentEvents } from '@/db/schema';
import { loadRows } from '@/lib/views/rows';
import { ladderInput } from '@/lib/shipments/repo';
import { upcomingPlan, RUNG_TEXT } from '@/lib/escalation/ladder';
import { STATE_LABEL } from '@/lib/carriers/correos/state-map';
import { now } from '@/lib/clock';
import { exact, human } from '@/lib/time';
import { HeroNumber, PayBadge, StateChip, Card, toneColour } from '@/components/ui';
import { ActionButton } from '@/components/RowActions';
import { CopyButton } from '@/components/CopyButton';
import { FileCall } from '@/components/FileCall';
import { DangerActions } from '@/components/DangerActions';
import { EventTimeline } from '@/components/EventTimeline';

export const dynamic = 'force-dynamic';

/**
 * One parcel, everything about it.
 *
 * Correos' own words on the left with what each one meant for us underneath,
 * and what the system will do next on its own. On the right: the office, the
 * customer, and one tap to file a call.
 */
export default async function ParcelPage({ params }: { params: { id: string } }) {
  const at = now();
  const all = await loadRows({ at });
  const row = all.find((r) => r.id === params.id);
  if (!row) notFound();

  const [events, log, input] = await Promise.all([
    db.select().from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, row.id))
      .orderBy(desc(shipmentEvents.occurredAt)),
    db.select().from(contactLog)
      .where(eq(contactLog.shipmentId, row.id))
      .orderBy(desc(contactLog.at)),
    ladderInput(row.id),
  ]);

  const plan = upcomingPlan(input, at, 4).map((r) => ({
    when: human(r.dueAt, at),
    exact: exact(r.dueAt),
    text: RUNG_TEXT[r.base] ?? r.id,
  }));

  const showsCountdown = row.state === 'at_office';
  const tone = row.countdownTone;

  return (
    <div className="px-4 pb-10 pt-4">
      <div className="mb-3 text-[12.5px] text-muted">
        Parcel <span className="text-line">/</span> {row.customerName}
      </div>

      <div
        className="flex flex-wrap items-start gap-[18px] rounded-[5px] border border-line bg-surface px-5 py-[18px] lg:gap-[26px]"
        style={{ borderLeft: `4px solid ${tone === 'calm' ? 'var(--line)' : toneColour(tone)}` }}
      >
        <div className="min-w-[180px] flex-none">
          <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">
            {showsCountdown ? 'Days left' : 'Where it is'}
          </div>
          <div className="mt-[2px] flex flex-wrap items-baseline gap-[10px]">
            {showsCountdown || row.state === 'returning'
              ? <HeroNumber value={row.countdown} tone={tone} size={70} />
              : <span className="font-display text-[26px] font-bold leading-[1.1] text-ink">{STATE_LABEL[row.state]}</span>}
            <span className="text-[13px] font-medium text-muted" title={row.exactWhen}>
              {showsCountdown ? `goes back ${row.when}` : row.when}
            </span>
          </div>
          <div className="mt-[6px]"><StateChip label={STATE_LABEL[row.state] ?? row.state} tone={tone} /></div>
        </div>

        <div className="w-px self-stretch bg-line" />

        <div className="grid min-w-[230px] flex-1 gap-x-[26px] gap-y-[14px] [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
          <Field label="Customer"><span className="font-display text-[15px] font-semibold">{row.customerName}</span></Field>
          <Field label="Order"><span className="font-mono text-[13px] font-medium">{row.orderNumber}</span></Field>
          <Field label="Code">
            <CopyButton
              text={row.shippingCode}
              said={`Code ${row.shippingCode} copied.`}
              className="border-b border-dashed border-line font-mono text-[13px] font-medium text-ink"
            >
              {row.shippingCode}
            </CopyButton>
          </Field>
          <Field label="Shop"><span className="text-[13px] font-medium">{row.storeName}</span></Field>
          <Field label="At risk"><span className="tnum text-[13px] font-semibold">{row.valueText}</span></Field>
          <Field label="Payment"><PayBadge method={row.paymentMethod} long /></Field>
        </div>

        <div className="flex min-w-[196px] flex-none flex-col gap-[7px]">
          <ActionButton shipmentId={row.id} action={row.action} big />
          {row.phoneE164 && (
            <a href={row.telHref} className="rounded border border-line bg-surface px-[13px] py-[10px] text-center font-mono text-[12.5px] font-semibold text-ink">
              {row.phoneDisplay}
            </a>
          )}
          <div className="flex gap-[6px]">
            <CopyButton
              text={row.messageText}
              said="Message copied — paste it into WhatsApp."
              className="flex-1 rounded border border-line bg-surface px-[11px] py-[9px] text-[12px] font-semibold text-ink"
            >
              Copy message
            </CopyButton>
            {row.waHref && (
              <a href={row.waHref} target="_blank" rel="noreferrer"
                className="flex-1 rounded border border-good bg-goodsoft px-[11px] py-[9px] text-center text-[12px] font-semibold text-good">
                WhatsApp
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="mt-[18px] grid items-start gap-5 lg:[grid-template-columns:minmax(0,1.15fr)_minmax(280px,.85fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <div className="mb-[10px] flex flex-wrap items-baseline gap-[10px]">
              <h2 className="m-0 font-display text-[15px] font-bold text-ink">What Correos told us</h2>
              <span className="text-[11.5px] text-muted">newest first · their words kept in Spanish</span>
            </div>
            <EventTimeline
              events={events.map((e, i) => ({
                id: e.id,
                desc: e.eventDesc,
                state: e.mappedState ? (STATE_LABEL[e.mappedState] ?? e.mappedState) : null,
                when: human(e.occurredAt, at),
                time: exact(e.occurredAt).split(', ')[1] ?? '',
                exact: exact(e.occurredAt),
                source: e.source === 'poll' ? 'Found in nightly check' : 'Live from Correos',
                first: i === 0,
              }))}
              tone={tone}
            />
          </div>

          <Card title="What happens next, on its own">
            {plan.length === 0 && (
              <div className="px-[14px] py-[13px] text-[12.5px] text-muted">
                Nothing scheduled — this parcel is finished or waiting on you.
              </div>
            )}
            {plan.map((p) => (
              <div key={p.text} className="flex flex-wrap items-baseline gap-3 border-b border-line px-[14px] py-[10px]">
                <span className="min-w-[86px] text-[12px] font-medium text-muted" title={p.exact}>{p.when}</span>
                <span className="text-[12.5px] leading-[1.45] text-ink">{p.text}</span>
              </div>
            ))}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {row.officeName && (
            <Card title="Post office">
              <div className="px-[14px] py-3">
                <div className="text-[13.5px] font-semibold text-ink">{row.officeName}</div>
                <div className="mt-[3px] text-[12.5px] leading-[1.5] text-muted">
                  {row.officeAddress}
                  {row.officeHours && <><br />{row.officeHours}</>}
                </div>
                <div className="mt-[9px] flex flex-wrap gap-[6px]">
                  <a href={row.mapsHref} target="_blank" rel="noreferrer"
                    className="rounded border border-line bg-surface2 px-[11px] py-2 text-[12px] font-semibold text-ink">
                    Open in maps
                  </a>
                  <CopyButton text={row.shippingCode} said={`Code ${row.shippingCode} copied.`}
                    className="rounded border border-line bg-surface2 px-[11px] py-2 text-[12px] font-semibold text-ink">
                    Copy code
                  </CopyButton>
                </div>
              </div>
            </Card>
          )}

          <Card title="Customer">
            <div className="grid grid-cols-[66px_minmax(0,1fr)] gap-x-3 gap-y-2 px-[14px] py-3 text-[12.5px]">
              <span className="text-muted">Phone</span>
              <span>
                {row.phoneE164
                  ? <a href={row.telHref} className="font-mono text-ink">{row.phoneDisplay}</a>
                  : <span className="text-warn">No number on this order</span>}
                {row.phoneStatus === 'landline' && (
                  <span className="mt-[2px] block text-[11px] text-warn">Landline — no WhatsApp, no SMS</span>
                )}
              </span>
              <span className="text-muted">Email</span>
              <span className="break-all font-mono text-[12px] text-ink">{row.email ?? '—'}</span>
              <span className="text-muted">Address</span>
              <span className="leading-[1.5] text-ink">{row.addressLine ?? '—'}</span>
            </div>
          </Card>

          <FileCall
            shipmentId={row.id}
            log={log.map((c) => ({
              id: c.id,
              when: human(c.at, at),
              exact: exact(c.at),
              outcome: c.outcome,
              note: c.note,
            }))}
          />

          <DangerActions
            shipmentId={row.id}
            dropped={row.dropped}
            canRedirect={row.state === 'at_office' || row.state === 'failed'}
          />
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">{label}</div>
      <div className="mt-[3px] text-ink">{children}</div>
    </div>
  );
}
