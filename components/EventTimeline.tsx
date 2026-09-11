import type { Tone } from '@/lib/escalation/decide';
import { toneColour } from './ui';

export interface TimelineEvent {
  id: string;
  desc: string;
  /** null when Correos sent something we have no mapping for. */
  state: string | null;
  when: string;
  time: string;
  exact: string;
  source: string;
  first: boolean;
}

/**
 * Correos' own words, exactly as they arrived, with the plain-English meaning
 * underneath. Keeping the Spanish is not decoration: when somebody rings
 * Correos, the sentence on this screen is the sentence to read out.
 *
 * An event we have never seen before is shown too, marked as not recognised,
 * rather than hidden — a gap in the timeline is worse than an unfamiliar line.
 */
export function EventTimeline({ events, tone }: { events: TimelineEvent[]; tone: Tone }) {
  if (!events.length) {
    return (
      <div className="rounded-[5px] border border-line bg-surface px-[14px] py-[13px] text-[12.5px] text-muted">
        Correos has not said anything about this parcel yet.
      </div>
    );
  }

  return (
    <div className="rounded-[5px] border border-line bg-surface">
      {events.map((e) => (
        <div key={e.id} className="grid grid-cols-[92px_14px_minmax(0,1fr)] gap-3 border-b border-line px-[14px] py-3">
          <div className="font-mono text-[11.5px] leading-[1.5] text-muted" title={e.exact}>
            {e.when}<br />{e.time}
          </div>
          <div className="flex flex-col items-center">
            <span
              className="mt-[5px] h-[9px] w-[9px] flex-none rounded-full border-2"
              style={{
                background: e.first ? toneColour(tone) : 'var(--surface)',
                borderColor: e.first ? toneColour(tone) : 'var(--muted)',
              }}
            />
            <span className="mt-1 w-px flex-1 bg-line" />
          </div>
          <div>
            <div className="text-[13px] font-medium italic text-ink">{e.desc}</div>
            <div className="mt-[5px] flex flex-wrap items-center gap-[7px]">
              {e.state ? (
                <span className="inline-block rounded-[3px] border border-line bg-surface2 px-[7px] py-[2px] text-[10.5px] font-semibold text-ink">
                  {e.state}
                </span>
              ) : (
                <span
                  className="inline-block rounded-[3px] border px-[7px] py-[2px] text-[10.5px] font-semibold"
                  style={{ borderColor: 'var(--warn)', background: 'var(--warnsoft)', color: 'var(--warn)' }}
                  title="We have no mapping for this one yet. It is logged for review and changed nothing."
                >
                  Not seen before — logged for review
                </span>
              )}
              <span className={e.source.startsWith('Found')
                ? 'inline-block rounded-[3px] border border-dashed border-muted px-[7px] py-[2px] text-[10px] font-medium text-muted'
                : 'text-[10.5px] font-medium text-muted'}>
                {e.source}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
