import { cookies } from 'next/headers';
import { requireUser } from '@/lib/auth/guard';
import { loadDemoClock, isDemoMode } from '@/lib/demo-clock';
import { recentActivity } from '@/lib/activity';
import { engineHealth, sweepStatus } from '@/lib/engine-health';
import { actionable } from '@/lib/escalation/decide';
import { loadRows } from '@/lib/views/rows';
import { now } from '@/lib/clock';
import { fmt } from '@/lib/time';
import { TopBar } from '@/components/TopBar';
import { Ticker } from '@/components/Ticker';
import { EngineBanner } from '@/components/EngineBanner';
import { Tabs } from '@/components/Tabs';
import { ToastHost } from '@/components/Toast';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await loadDemoClock();

  // engineHealth() has to come after loadDemoClock(): in demo mode job_runs
  // rows are stamped from the offset clock, and reading one against the system
  // clock would make a working engine look stopped.
  const [ticker, rows, health, sweep] = await Promise.all([
    recentActivity(24),
    loadRows(),
    engineHealth(),
    sweepStatus(),
  ]);

  const at = now();
  const todo = actionable(rows, at).length;
  const f = fmt(at);

  return (
    <ToastHost>
      <div className="min-h-screen bg-ground text-ink">
        <TopBar
          dateLabel={`${f.day} ${f.date} · ${f.time}`}
          todoCount={todo}
          theme={cookies().get('rs_theme')?.value === 'dark' ? 'dark' : 'light'}
          demo={isDemoMode()}
          userName={user.name}
        />
        <EngineBanner health={health} />
        <Ticker items={ticker} />

        {/*
          No dock. The "Customer phone / Correos updates" panel that used to
          sit on the right is gone, and the main content takes the full width —
          which the new Parcels table needs, eight columns of it.

          The component files are kept, not deleted: the panel comes back if
          WhatsApp is ever connected, and the parcel page still has its own
          Copy message and WhatsApp buttons, which is where that belongs
          anyway.
        */}
        <div className="min-w-0">
          <Tabs lastChecked={sweep.ago} lastCheckedExact={sweep.exactWhen} />
          {children}
        </div>
      </div>
    </ToastHost>
  );
}
