import { cookies } from 'next/headers';
import { requireUser } from '@/lib/auth/guard';
import { loadDemoClock, isDemoMode } from '@/lib/demo-clock';
import { getSettings } from '@/lib/settings';
import { recentActivity } from '@/lib/activity';
import { actionable } from '@/lib/escalation/decide';
import { loadRows } from '@/lib/views/rows';
import { now } from '@/lib/clock';
import { fmt } from '@/lib/time';
import { TopBar } from '@/components/TopBar';
import { Ticker } from '@/components/Ticker';
import { Tabs } from '@/components/Tabs';
import { Dock } from '@/components/Dock';
import { ToastHost } from '@/components/Toast';

// Per-request, behind a login or a signed token, and it reads the database.
// Saying so explicitly keeps it out of the build's static render pass, which
// is what would otherwise make every build need a live production database.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await loadDemoClock();

  const [settings, ticker, rows] = await Promise.all([
    getSettings(),
    recentActivity(24),
    loadRows(),
  ]);

  const at = now();
  const todo = actionable(rows, at).length;
  const f = fmt(at);

  return (
    <ToastHost>
      <div className="min-h-screen bg-ground text-ink">
        <TopBar
          dateLabel={`${f.day} ${f.date} · ${f.time}`}
          phase={settings.phase}
          todoCount={todo}
          theme={cookies().get('rs_theme')?.value === 'dark' ? 'dark' : 'light'}
          demo={isDemoMode()}
          userName={user.name}
        />
        <Ticker items={ticker} />

        <div className="flex flex-col items-start lg:flex-row">
          <div className="min-w-0 flex-1">
            <Tabs />
            {children}
          </div>
          <Dock />
        </div>
      </div>
    </ToastHost>
  );
}
