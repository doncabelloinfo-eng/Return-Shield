'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { setPhase, toggleTheme } from '@/app/actions/settings';
import { advanceDemoClock, resetDemo } from '@/app/actions/demo';

/**
 * The bar across the top. Left to right: who we are, what time it is, which
 * step we are on, and how much is owed today.
 *
 * The clock controls only exist in demo mode. In production the time is the
 * time, and the little "+1 day" button that made the prototype demonstrable
 * would be a way to fire fifteen days of reminders at real customers.
 */

export interface TopBarProps {
  dateLabel: string;
  phase: 1 | 2;
  todoCount: number;
  theme: 'light' | 'dark';
  demo: boolean;
  userName: string;
}

export function TopBar({ dateLabel, phase, todoCount, theme, demo, userName }: TopBarProps) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<unknown>) => () => start(async () => { await fn(); router.refresh(); });

  const ghost = 'whitespace-nowrap rounded border border-white/20 px-[10px] py-[7px] text-[11.5px] font-semibold text-white hover:bg-white/10 disabled:opacity-50';

  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center gap-[14px] bg-navy px-4 py-[10px] text-white">
      <div className="flex items-center gap-[9px]">
        <span className="h-[10px] w-[10px] rounded-[2px] bg-accent" />
        <span className="whitespace-nowrap font-display text-[15px] font-bold tracking-[.02em]">Return Shield</span>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-white/20 bg-white/5 px-2 py-[5px]">
        <span className="min-w-[150px] whitespace-nowrap font-mono text-[12px] font-medium">{dateLabel}</span>
        {demo && (
          <>
            <button type="button" disabled={pending} onClick={run(() => advanceDemoClock(60))}
              className="whitespace-nowrap rounded border border-white/20 px-[9px] py-[6px] text-[11.5px] font-semibold hover:bg-white/10 disabled:opacity-50">
              +1 hour
            </button>
            <button type="button" disabled={pending} onClick={run(() => advanceDemoClock(1440))}
              className="whitespace-nowrap rounded border border-accent bg-accent px-[9px] py-[6px] text-[11.5px] font-bold text-navy disabled:opacity-50">
              +1 day
            </button>
          </>
        )}
      </div>

      <div className="flex items-center overflow-hidden rounded-md border border-white/20">
        <button type="button" disabled={pending} onClick={run(() => setPhase(1))}
          className={`whitespace-nowrap px-[11px] py-2 text-[11.5px] font-bold ${phase === 1 ? 'bg-accent text-navy' : 'text-white'}`}>
          Step 1 — just for us
        </button>
        <button type="button" disabled={pending} onClick={run(() => setPhase(2))}
          className={`whitespace-nowrap border-l border-white/20 px-[11px] py-2 text-[11.5px] font-bold ${phase === 2 ? 'bg-accent text-navy' : 'text-white'}`}>
          Step 2 — we message customers
        </button>
      </div>

      <div className="ml-auto flex items-center gap-[7px]">
        <span
          className="whitespace-nowrap rounded border px-[10px] py-[6px] text-[11.5px] font-semibold"
          style={todoCount
            ? { background: 'rgba(242,183,5,.16)', borderColor: 'var(--accent)', color: 'var(--accent)' }
            : { background: 'rgba(52,177,131,.18)', borderColor: '#34B183', color: '#8FE3C2' }}
        >
          {todoCount ? `${todoCount} to do` : 'all clear'}
        </span>
        <button type="button" onClick={run(() => toggleTheme(theme === 'dark' ? 'light' : 'dark'))} className={ghost}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
        {demo && (
          <button type="button" disabled={pending} onClick={run(resetDemo)} className={ghost}>Start over</button>
        )}
        <form action="/api/logout" method="post">
          <button type="submit" className={ghost} title={userName}>Sign out</button>
        </form>
      </div>
    </div>
  );
}
