import type { JobHealth } from '@/lib/engine-health';
import { Card, Chip } from './ui';

/**
 * When each job last ran.
 *
 * Two different facts per job, because they answer different questions. The
 * heartbeat says the scheduler fired at all — a job that correctly skipped
 * still proves Vercel reached us. The real run says it last did some work. A
 * job heartbeating hourly and never doing anything is usually right (there was
 * nothing to do) and occasionally the whole problem, so both are on the screen.
 */
export function JobRunsPanel({ jobs }: { jobs: JobHealth[] }) {
  const silent = jobs.filter((j) => j.lastHeartbeatAt === null).length;
  const failing = jobs.filter((j) => j.failingSince !== null).length;

  return (
    <Card
      title="Scheduled jobs"
      note={failing
        ? `${failing} failing`
        : silent === jobs.length
          ? 'none of them has ever run'
          : silent
            ? `${silent} has never run`
            : 'all running'}
    >
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <Th>Job</Th>
              <Th>How often</Th>
              <Th>Last heard from</Th>
              <Th>Last did something</Th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.job}>
                <td className="whitespace-nowrap border-b border-line px-[14px] py-[10px] font-mono text-[12px] text-ink">
                  {j.job}
                </td>
                <td className="border-b border-line px-[14px] py-[10px] text-[12px] text-muted">
                  {j.cadence}
                </td>
                <td className="whitespace-nowrap border-b border-line px-[14px] py-[10px] text-[12.5px]">
                  {j.failingSince ? (
                    <Chip colour="var(--crit)" background="var(--critsoft)">
                      failing since {j.failingSinceAgo}
                    </Chip>
                  ) : j.lastHeartbeatAgo ? (
                    <span className="text-ink" title={j.lastHeartbeatExact ?? undefined}>
                      {j.lastHeartbeatAgo}
                    </span>
                  ) : (
                    <Chip colour="var(--muted)" background="var(--surface2)">never</Chip>
                  )}
                </td>
                <td className="whitespace-nowrap border-b border-line px-[14px] py-[10px] text-[12.5px] text-muted">
                  {j.lastRealRunAgo ?? (j.lastHeartbeatAt ? 'nothing to do yet' : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-[14px] py-3 text-[12px] leading-[1.5] text-muted">
        &ldquo;Last heard from&rdquo; includes a run that correctly had nothing to do — that is
        still proof the scheduler reached us, which is what the banner on every screen
        watches for. A job that has never been heard from usually means{' '}
        <code className="font-mono">CRON_SECRET</code> is unset or the schedule is missing.
      </div>
    </Card>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="whitespace-nowrap border-b border-line px-[14px] py-[9px] text-left text-[10px] font-semibold uppercase tracking-[.09em] text-muted">
      {children}
    </th>
  );
}
