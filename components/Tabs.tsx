'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/today', label: 'Today' },
  { href: '/office', label: 'Post office' },
  { href: '/import', label: 'Add TikTok orders' },
  { href: '/calls', label: 'Call list' },
  { href: '/settings', label: 'Settings' },
];

export function Tabs() {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-[6px] px-4 pt-3">
      {TABS.map((t) => {
        const on = path === t.href || (t.href !== '/today' && path.startsWith(t.href));
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? 'page' : undefined}
            className={`whitespace-nowrap rounded-[5px] border px-[13px] py-[9px] text-[12.5px] font-semibold ${
              on ? 'border-navy bg-navy text-white' : 'border-line bg-surface text-ink'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
      {path.startsWith('/parcel') && (
        <span className="whitespace-nowrap rounded-[5px] border border-navy bg-navy px-[13px] py-[9px] text-[12.5px] font-semibold text-white">
          Parcel
        </span>
      )}
    </nav>
  );
}
