import { Card } from './ui';
import type { SweepCapacity, SweepSilence } from '@/lib/sweep-health';

/**
 * What the Correos sweep can get through, what it is costing, and whether it
 * is learning anything at all.
 *
 * The last of those three is why the panel exists. On 8 October six hourly
 * runs in a row asked about all 201 parcels and stored nothing, while Correos
 * had hundreds of events for them — and every screen in the app looked
 * perfectly healthy, because "nothing changed" is also what a quiet night
 * looks like. The warning below is the one thing that tells those two apart.
 */
export function SweepPanel({
  capacity, silence,
}: {
  capacity: SweepCapacity;
  silence: SweepSilence;
}) {
  return (
    <Card
      title="Checking with Correos"
      note={`every ${capacity.recheckHours} hours, or every ${capacity.urgentRecheckHours}`
        + ' for the ones about to go somewhere'}
    >
      {silence.warn && (
        <div
          className="border-b border-line border-l-4 border-l-crit px-[14px] py-[13px] text-[12.5px] leading-[1.55] text-ink"
          style={{ background: 'var(--critsoft)' }}
        >
          <strong>
            The last {silence.silentRuns} automatic checks asked about{' '}
            {silence.askedInSilence.toLocaleString('en-GB')} parcels and stored nothing.
          </strong>{' '}
          That can be a genuinely quiet spell, and it is also exactly what a broken check looks
          like — on 8 October a cached response meant six runs in a row asked Correos nothing at
          all. Compare a parcel against Correos&rsquo; public tracker: if the tracker has events
          this app does not, the check is not reaching them.
        </div>
      )}

      <div className="border-b border-line px-[14px] py-3 last:border-b-0">
        <div className="text-[12.5px] leading-[1.6] text-ink">{capacity.line}</div>

        {capacity.overdue > 0 && (
          <div className="mt-[5px] text-[12px] font-semibold text-crit">
            {capacity.overdue.toLocaleString('en-GB')}{' '}
            {capacity.overdue === 1 ? 'parcel has' : 'parcels have'} gone longer than the rule
            allows. The hourly check works through the oldest first.
          </div>
        )}

        <div className="mt-[6px] text-[11.5px] leading-[1.5] text-muted">
          {capacity.due.toLocaleString('en-GB')}{' '}
          {capacity.due === 1 ? 'parcel is' : 'parcels are'} due right now. A check with nothing
          due ends without asking Correos anything.
        </div>
      </div>

      <div className="border-b border-line px-[14px] py-3 last:border-b-0">
        <div className="text-[12.5px] text-ink">{capacity.costLine}</div>
        {/*
          Said plainly because it is the one number that decides the bill, and
          because it is not the number anybody expects: the sweep is almost
          entirely spent waiting on Correos, so what it costs is how long it
          was alive — not how much work it did.
        */}
        <div className="mt-[5px] max-w-[620px] text-[11.5px] leading-[1.5] text-muted">
          Memory is billed for the whole time a check is alive and processor time only while code
          is running. Nearly all of a check is spent waiting for Correos to answer, so shorter and
          fewer checks are what keep this small — which is why the hourly check asks only about
          the parcels that are due.
        </div>
      </div>
    </Card>
  );
}
