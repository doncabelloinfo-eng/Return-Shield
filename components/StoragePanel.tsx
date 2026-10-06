import { FREE_PLAN_BYTES, DB_WARN_BYTES } from '@/lib/retention';
import { Card } from './ui';

/**
 * What the database weighs, against the plan's ceiling.
 *
 * Supabase's free plan stops at 500 MB, and until the rolling window shipped
 * nothing here deleted anything — one `shipment_events` row carries about 550
 * bytes of raw Correos payload, which at a thousand parcels a day is roughly a
 * gigabyte a year. So the only question was when it would stop, and nothing on
 * any screen would have said why.
 *
 * The bar is measured after the nightly cleanup, so what it shows is whether
 * the window is actually holding the database still rather than merely slowing
 * its growth.
 */
export function StoragePanel({ bytes, windowDays }: { bytes: number; windowDays: number }) {
  const mb = bytes / (1024 * 1024);
  const limitMb = FREE_PLAN_BYTES / (1024 * 1024);
  const pct = Math.min(100, Math.round((bytes / FREE_PLAN_BYTES) * 1000) / 10);
  const warn = bytes >= DB_WARN_BYTES;

  return (
    <Card
      title="Database size"
      note={`${mb.toFixed(1)} MB of ${limitMb} MB · ${pct}%`}
    >
      <div className="px-[14px] py-[12px]">
        <div
          className="h-[9px] w-full overflow-hidden rounded-full"
          style={{ background: 'var(--surface2)' }}
          role="img"
          aria-label={`${pct}% of the ${limitMb} MB limit used`}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.max(pct, 0.6)}%`,
              background: warn ? 'var(--crit)' : 'var(--good, var(--navy))',
            }}
          />
        </div>

        {warn ? (
          <div className="mt-[9px] text-[12.5px] font-semibold leading-[1.5] text-crit">
            Over 400 MB. The free plan stops at {limitMb} MB, and when it does, writes fail —
            which means tracking stops arriving. Either shorten the window with{' '}
            <code className="font-mono">RETENTION_DAYS</code> or move off the free plan.
          </div>
        ) : (
          <div className="mt-[9px] text-[12.5px] leading-[1.5] text-muted">
            The nightly cleanup keeps the last {windowDays} days and deletes the day that has
            just fallen off the end, so this should stay flat rather than climb. A parcel that is
            past {windowDays} days and still not finished is kept, not deleted, and shows up under
            Parcels → <span className="font-semibold">Stuck {windowDays}+ days</span>.
          </div>
        )}

        <div className="mt-[7px] text-[11.5px] leading-[1.5] text-muted">
          Never deleted: users, shops, settings, deposit windows, post offices, the areas we
          watch, and the record of every parcel closed by hand.
        </div>
      </div>
    </Card>
  );
}
