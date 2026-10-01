import type { EngineHealth } from '@/lib/engine-health';

/**
 * The banner that appears when nothing has run.
 *
 * This is the one failure in the system that is invisible from the inside: with
 * `CRON_SECRET` missing or wrong, every cron route answers 401 and the
 * dashboard carries on showing countdowns that nothing is counting down. So
 * the banner is loud, it is on every screen, and it is not dismissible —
 * dismissing it would hide the only sign that parcels are quietly going back.
 *
 * It names the two things that actually cause it, because "something is wrong"
 * is not actionable at eight in the morning.
 */
export function EngineBanner({ health }: { health: EngineHealth }) {
  if (health.state === 'healthy' || health.state === 'unknown') return null;

  const neverRan = health.state === 'never-ran';

  return (
    <div
      role="alert"
      className="border-b border-crit px-4 py-3"
      style={{ background: 'var(--critsoft)' }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-[14px] font-bold text-crit">
          {neverRan
            ? 'Nothing has ever run. No parcel is being chased.'
            : 'The engine has stopped. No parcel is being chased.'}
        </span>
        {!neverRan && (
          <span className="text-[12.5px] text-ink" title={health.exactWhen}>
            Last run was <strong>{health.ago}</strong> ({health.lastJob}).
          </span>
        )}
      </div>

      <p className="mt-[6px] max-w-[760px] text-[12.5px] leading-[1.55] text-ink">
        Countdowns on these screens are still being worked out from the deadlines, but
        nothing is sending messages, opening call tasks or asking Correos for updates.
        Parcels will go back without anybody being told.{' '}
        {neverRan
          ? 'If this deployment is new, the usual cause is that CRON_SECRET has not been set — '
            + 'without it every scheduled job refuses every request, by design.'
          : 'The two usual causes are a changed or missing CRON_SECRET, and the cron schedule '
            + 'being removed or disabled.'}
      </p>

      <ul className="mt-2 list-inside list-disc text-[12.5px] leading-[1.6] text-ink">
        <li>
          Check <code className="font-mono">CRON_SECRET</code> is set in the Vercel project
          settings — every job answers 401 without it.
        </li>
        <li>Check the Vercel dashboard&rsquo;s Cron Jobs tab for the last invocation of each job.</li>
        <li>
          Settings &rarr; Connections lists when each job last ran, which narrows it down to
          one job or all of them.
        </li>
      </ul>
    </div>
  );
}
