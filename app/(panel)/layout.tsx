import { cookies } from 'next/headers';
import { requireUser } from '@/lib/auth/guard';
import { loadDemoClock, isDemoMode } from '@/lib/demo-clock';
import { recentActivity } from '@/lib/activity';
import { engineHealth, sweepStatus } from '@/lib/engine-health';
import { todoCount } from '@/lib/views/todo';
import { withDbRetry } from '@/db';
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

  /*
   * engineHealth() has to come after loadDemoClock(): in demo mode job_runs
   * rows are stamped from the offset clock, and reading one against the system
   * clock would make a working engine look stopped.
   *
   * ONE RETRY PER LOADER, not one around all four. This layout wraps every
   * panel screen, so a pooler that is full for a quarter of a second costs a
   * beat here instead of "Application error" on whichever of these lost the
   * race — but wrapping the whole `Promise.all` meant a single refusal re-ran
   * all four, which is sixteen connection attempts against the resource that
   * had just run out. `todoCount` brings its own retry (lib/views/todo.ts),
   * and `withDbRetry` is re-entrant, so nothing here can nest.
   */
  const [ticker, todo, health, sweep] = await Promise.all([
    withDbRetry('recent activity', () => recentActivity(24)),
    todoCount(),
    withDbRetry('engine health', () => engineHealth()),
    withDbRetry('sweep status', () => sweepStatus()),
  ]);

  const at = now();
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
