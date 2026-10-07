import { sql as raw, and, eq, desc, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { eventReviewQueue, postcodeStats, productRules, shipments, stores } from '@/db/schema';
import { ShopifyPull } from '@/components/ShopifyPull';
import { DepositRow } from '@/components/DepositRow';
import { IntegrationsPanel } from '@/components/IntegrationsPanel';
import { JobRunsPanel } from '@/components/JobRunsPanel';
import { integrationStatus } from '@/lib/integrations';
import { jobHealth } from '@/lib/engine-health';
import { getSetting } from '@/lib/settings';
import { Card, PageHeading, Bilingual } from '@/components/ui';
import { StoragePanel } from '@/components/StoragePanel';
import { databaseBytes } from '@/lib/cleanup';
import { retentionDays } from '@/lib/retention';
import { eventLabels } from '@/lib/carriers/correos/state-map';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * The one number everything hangs off.
 *
 * Correos keeps a parcel for a set number of days, then sends it back. Every
 * deadline, countdown and reminder hangs off this. Change it and the post
 * office list re-sorts straight away.
 */
export default async function SettingsPage() {
  const [rules, counts, watched, review, integrations, jobs, batchMode, bytes, shopifyStores] = await Promise.all([
    getDb().select().from(productRules).orderBy(productRules.productCode),
    getDb().select({ code: shipments.productCode, n: raw<number>`count(*)::int` })
      .from(shipments).groupBy(shipments.productCode),
    getDb().select().from(postcodeStats).where(eq(postcodeStats.watch, true)).orderBy(desc(postcodeStats.failRate)),
    getDb().select().from(eventReviewQueue)
      .where(isNull(eventReviewQueue.resolvedAt))
      .orderBy(desc(eventReviewQueue.lastSeenAt)).limit(20),
    integrationStatus(),
    jobHealth(),
    getSetting('correosBatchMode'),
    databaseBytes(),
    getDb().select({ key: stores.key, name: stores.name }).from(stores)
      .where(and(eq(stores.platform, 'shopify'), eq(stores.active, true)))
      .orderBy(stores.name),
  ]);

  const windowDays = retentionDays();

  const countFor = (code: string) => counts.find((c) => c.code === code)?.n ?? 0;
  const anyUnconfirmed = rules.some((r) => !r.confirmedWithCarrier);

  return (
    <div className="max-w-[860px] px-4 pb-10 pt-[18px]">
      <PageHeading
        title="Settings — how long the post office waits"
        note="Correos keeps a parcel for a set number of days, then sends it back. Every deadline, countdown and reminder hangs off this one number. Change it and watch the post office list re-sort."
      />

      {anyUnconfirmed && (
        <div
          className="mt-4 rounded-[5px] border border-line border-l-4 border-l-warn px-[15px] py-[13px] text-[12.5px] leading-[1.55] text-ink"
          style={{ background: 'var(--warnsoft)' }}
        >
          <strong>These numbers are still a guess.</strong> Nobody has confirmed the deposit window
          with Correos yet, and the real figure may differ by service. Until somebody does, every
          countdown on every screen is an estimate — tick a service off below once it has been
          confirmed.
        </div>
      )}

      <div className="mt-[18px] overflow-hidden rounded-[5px] border border-line bg-surface">
        {rules.length === 0 && (
          <div className="px-4 py-[14px] text-[12.5px] text-muted">
            No services yet. They appear here the first time a parcel is shipped on one.
          </div>
        )}
        {rules.map((r) => (
          <DepositRow
            key={r.productCode}
            productCode={r.productCode}
            days={r.depositDays}
            confirmed={r.confirmedWithCarrier}
            count={countFor(r.productCode)}
          />
        ))}
      </div>

      <div
        className="mt-[14px] rounded-[5px] border border-line border-l-4 border-l-warn px-[15px] py-[13px] text-[12.5px] leading-[1.55] text-ink"
        style={{ background: 'var(--warnsoft)' }}
      >
        Cutting the days can put a parcel past its last day straight away — exactly what happens
        in real life when Correos changes how long they hold things.
      </div>

      <div className="mt-[22px]">
        <IntegrationsPanel integrations={integrations} batchMode={batchMode} />
      </div>

      <div className="mt-[22px]">
        <JobRunsPanel jobs={jobs} />
      </div>

      <div className="mt-[22px] rounded-[5px] border border-line bg-surface px-4 py-[14px]">
        <div className="font-display text-[12.5px] font-bold text-ink">Areas we watch</div>
        <div className="mt-[5px] text-[12.5px] leading-[1.55] text-muted">
          {watched.length
            ? <>
                {watched.map((w) => w.town ?? w.postalCode).join(', ')} fail far more often than
                average, so a new order to one of them gets flagged at dispatch — before anything
                has gone wrong. Preventing one failed delivery beats rescuing three.
              </>
            : <>
                Nothing is being watched yet. The nightly job builds these from what has actually
                failed, so it needs a few weeks of deliveries before it can say anything useful.
              </>}
        </div>
        <div className="mt-[7px] text-[11.5px] leading-[1.5] text-muted">
          Worked out from the last {windowDays} days only, because that is all the system keeps.
          A postcode whose last parcel has aged out of the window drops off this list rather than
          keeping an old failure rate with no parcels behind it.
        </div>
        {watched.length > 0 && (
          <table className="mt-3">
            <thead>
              <tr>
                <th className="border-b border-line py-2 text-left text-[10px] font-semibold uppercase tracking-[.09em] text-muted">Area</th>
                <th className="border-b border-line py-2 text-right text-[10px] font-semibold uppercase tracking-[.09em] text-muted">Shipped</th>
                <th className="border-b border-line py-2 text-right text-[10px] font-semibold uppercase tracking-[.09em] text-muted">Failed</th>
                <th className="border-b border-line py-2 text-right text-[10px] font-semibold uppercase tracking-[.09em] text-muted">Fail rate</th>
              </tr>
            </thead>
            <tbody>
              {watched.map((w) => (
                <tr key={w.postalCode}>
                  <td className="border-b border-line py-2 text-[12.5px] text-ink">{w.town ?? w.postalCode}</td>
                  <td className="tnum border-b border-line py-2 text-right text-[12.5px] text-muted">{w.shipped}</td>
                  <td className="tnum border-b border-line py-2 text-right text-[12.5px] text-muted">{w.failed}</td>
                  <td className="tnum border-b border-line py-2 text-right text-[12.5px] font-semibold text-warn">
                    {Math.round(w.failRate * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {shopifyStores.length > 0 && (
        <div className="mt-[22px]">
          <Card
            title="Shopify"
            note={`history, per shop · the last ${windowDays} days`}
          >
            {shopifyStores.map((st) => (
              <ShopifyPull key={st.key} storeKey={st.key} storeName={st.name} windowDays={windowDays} />
            ))}
            <div className="px-[14px] py-3 text-[11.5px] leading-[1.5] text-muted">
              New parcels arrive on their own by webhook, and the hourly check picks up any
              whose webhook never came. This is for history: the first time a shop is
              connected, or after a gap.
            </div>
          </Card>
        </div>
      )}

      <div className="mt-[22px]">
        <StoragePanel bytes={bytes} windowDays={windowDays} />
      </div>

      {review.length > 0 && (
        <div className="mt-[22px]">
          <Card
            title="Things Correos said that we do not recognise"
            note="kept, shown on the parcel, and changed nothing"
          >
            {review.map((r) => (
              <div key={r.id} className="border-b border-line px-[14px] py-[11px]">
                {/* English first, Correos' sentence beneath — the same way round
                    as everywhere else the operator looks. Their wording is the
                    evidence, so it is never rewritten, only labelled. */}
                <Bilingual {...eventLabels(null, r.eventDesc)} size={12.5} />
                <div className="mt-1 text-[11.5px] text-muted">
                  code <span className="font-mono">{r.eventCode}</span> · seen {r.timesSeen}{' '}
                  {r.timesSeen === 1 ? 'time' : 'times'}
                </div>
              </div>
            ))}
            <div className="px-[14px] py-3 text-[12px] leading-[1.5] text-muted">
              Add these to <span className="font-mono">lib/carriers/correos/state-map.ts</span> and
              replay the events — nothing is lost, because every payload is kept exactly as it
              arrived.
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
