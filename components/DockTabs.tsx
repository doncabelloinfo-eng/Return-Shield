'use client';

import Link from 'next/link';
import { useState } from 'react';

export interface DockMessage {
  id: string; shipmentId: string; body: string; linkLabel: string | null;
  status: string; time: string; customerName: string; storeName: string;
}

export interface DockEvent {
  id: string; shipmentId: string; desc: string; state: string; known: boolean;
  source: string; when: string; exact: string; who: string;
}

/**
 * The WhatsApp panel is drawn in WhatsApp's own colours rather than the app's,
 * on purpose: it is a picture of the customer's phone, and it should not
 * change when the operator switches to dark mode.
 */
export function DockTabs({ messages, feed }: { messages: DockMessage[]; feed: DockEvent[] }) {
  const [tab, setTab] = useState<'phone' | 'feed'>('phone');
  const [open, setOpen] = useState(false);

  const people = [...new Map(messages.map((m) => [m.customerName, m])).values()].slice(0, 6);
  const [who, setWho] = useState<string | null>(null);
  const shown = who ? messages.filter((m) => m.customerName === who) : (people[0]
    ? messages.filter((m) => m.customerName === people[0].customerName) : []);
  const current = shown[0] ?? null;

  const tabStyle = (on: boolean) =>
    `flex-1 border-b-2 px-2 py-[10px] text-[12.5px] font-semibold text-ink ${on ? 'border-accent' : 'border-transparent'}`;

  return (
    <aside className="w-full flex-none border-t border-line bg-ground lg:sticky lg:top-[74px] lg:h-[calc(100vh-74px)] lg:w-[360px] lg:border-l lg:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full border-b border-line bg-surface px-3 py-2 text-left text-[12px] font-semibold text-ink lg:hidden"
      >
        {open ? 'Hide panel' : 'Messages and Correos updates'}
      </button>

      <div className={`${open ? 'flex' : 'hidden'} h-full flex-col lg:flex`}>
        <div className="flex border-b border-line bg-surface">
          <button type="button" className={tabStyle(tab === 'phone')} onClick={() => setTab('phone')}>
            Customer phone
          </button>
          <button type="button" className={tabStyle(tab === 'feed')} onClick={() => setTab('feed')}>
            Correos updates
          </button>
        </div>

        {tab === 'phone' ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="mb-[10px] flex flex-wrap gap-[6px]">
              {people.map((p) => {
                const on = (who ?? people[0]?.customerName) === p.customerName;
                return (
                  <button
                    key={p.customerName}
                    type="button"
                    onClick={() => setWho(p.customerName)}
                    className={`whitespace-nowrap rounded border px-[10px] py-[7px] text-[11.5px] font-semibold ${
                      on ? 'border-navy bg-navy text-white' : 'border-line bg-surface2 text-muted'
                    }`}
                  >
                    {p.customerName.split(' ')[0]} · {messages.filter((m) => m.customerName === p.customerName).length}
                  </button>
                );
              })}
            </div>

            <div className="mx-auto w-[min(330px,100%)] overflow-hidden rounded-[30px] border-[9px] border-[#0B1220] bg-[#0B1220] shadow-toast">
              <div className="flex h-[22px] items-center justify-between bg-[#075E54] px-3 text-[9.5px] font-medium text-white/85">
                <span>{current?.time ?? '--:--'}</span><span>5G ▪ 78%</span>
              </div>
              <div className="flex items-center gap-[9px] bg-[#075E54] px-3 py-[9px] text-white">
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#F2B705] font-display text-[12px] font-bold text-[#10203D]">
                  {(current?.storeName ?? 'RS').split(' ').map((w) => w[0]).slice(0, 2).join('')}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{current?.storeName ?? 'Return Shield'}</span>
                  <span className="block text-[10px] text-white/70">cuenta de empresa · solo envío</span>
                </span>
              </div>

              <div className="flex h-[326px] flex-col gap-2 overflow-auto bg-[#ECE5DD] p-[10px]">
                {shown.length === 0 && (
                  <div className="m-auto rounded-lg bg-white/95 p-[18px] text-center">
                    <div className="text-[12.5px] font-semibold text-[#10203D]">Nothing has gone out yet</div>
                    <div className="mt-[5px] text-[11.5px] leading-[1.5] text-[#5A6478]">
                      On Step 1 the system writes the message and you send it from your own
                      WhatsApp — the Copy message button on every parcel.
                    </div>
                  </div>
                )}
                {[...shown].reverse().map((m) => (
                  <div key={m.id} className="max-w-[86%] self-start rounded-[9px] rounded-tl-[2px] bg-white px-[10px] py-2 shadow-sm">
                    <div className="whitespace-pre-wrap text-[12px] leading-[1.45] text-[#111826]">{m.body}</div>
                    {m.linkLabel && (
                      <Link
                        href={`/parcel/${m.shipmentId}`}
                        className="mt-[7px] block w-full border-t border-[#E3E8EF] pt-2 text-center text-[12px] font-semibold text-[#0E7C56]"
                      >
                        ↗ {m.linkLabel}
                      </Link>
                    )}
                    <div className="mt-[3px] text-right font-mono text-[9.5px] text-[#8A94A6]">
                      {m.time} {m.status === 'sent' ? '✓✓' : m.status === 'queued' ? '· waiting for you to send it' : '✓'}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 border-t border-[#DDE1E7] bg-[#F0F2F5] px-[10px] py-2">
                <span className="flex-1 rounded-[18px] bg-[#E4E7EB] px-[11px] py-2 text-[11.5px] text-[#8A94A6]">
                  Este número no admite respuestas
                </span>
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#C7CDD6] text-[12px] font-semibold text-white">➤</span>
              </div>
            </div>

            <p className="mt-[10px] text-center text-[11px] leading-[1.5] text-muted">
              Every message carries a link, never a reply button — this number cannot receive
              replies, so a reply button would be a trap.
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-3 py-[10px]">
            <div className="mb-2 text-[11.5px] text-muted">
              {feed.length} updates from Correos · newest first · with what each one meant for us
            </div>
            {feed.map((e) => (
              <Link key={e.id} href={`/parcel/${e.shipmentId}`} className="block border-b border-line py-[9px]">
                <div className="flex items-baseline gap-2">
                  <span className="whitespace-nowrap font-mono text-[10.5px] text-muted" title={e.exact}>{e.when}</span>
                  <span className="text-[12px] font-medium italic leading-[1.4] text-ink">{e.desc}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-[6px]">
                  <span
                    className="inline-block rounded-[3px] border px-[6px] py-[2px] text-[10px] font-semibold"
                    style={e.known
                      ? { background: 'var(--surface2)', borderColor: 'var(--line)', color: 'var(--ink)' }
                      : { background: 'var(--warnsoft)', borderColor: 'var(--warn)', color: 'var(--warn)' }}
                  >
                    {e.state}
                  </span>
                  <span className="text-[10px] text-muted">{e.source}</span>
                  <span className="text-[11px] text-muted">{e.who}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
