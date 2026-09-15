import type { Integration } from '@/lib/integrations';
import { Card, Chip } from './ui';

/**
 * What is connected, and what is not.
 *
 * None of these credentials exist on day one and the dashboard still has to be
 * usable, so a missing integration says what stops working in terms of what
 * the business loses — not the name of an environment variable and nothing
 * else. The variable names are there too, because somebody has to paste them
 * into Vercel, but they are the footnote rather than the message.
 */
export function IntegrationsPanel({ integrations }: { integrations: Integration[] }) {
  const notReady = integrations.filter((i) => i.status !== 'ready').length;

  return (
    <Card
      title="Connections"
      note={notReady
        ? `${notReady} still to set up — the rest of the app works without ${notReady === 1 ? 'it' : 'them'}`
        : 'everything is connected'}
    >
      {integrations.map((i) => (
        <div key={i.key} className="border-b border-line px-[14px] py-3 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold text-ink">{i.name}</span>
            <StatusChip status={i.status} />
          </div>
          <p className="mt-[5px] max-w-[640px] text-[12.5px] leading-[1.55] text-muted">{i.detail}</p>
          {i.missingVars.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-[6px]">
              <span className="text-[11px] text-muted">Still to set:</span>
              {i.missingVars.map((v) => (
                <code
                  key={v}
                  className="rounded-[3px] border border-line bg-surface2 px-[6px] py-[2px] font-mono text-[11px] text-ink"
                >
                  {v}
                </code>
              ))}
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

function StatusChip({ status }: { status: Integration['status'] }) {
  if (status === 'ready') return <Chip colour="var(--good)" background="var(--goodsoft)">Connected</Chip>;
  if (status === 'partial') return <Chip colour="var(--warn)" background="var(--warnsoft)">Partly set up</Chip>;
  return <Chip colour="var(--muted)" background="var(--surface2)">Not set up</Chip>;
}
