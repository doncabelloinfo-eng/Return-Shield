'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { pullShopifyHistory, sweepPulledParcels } from '@/app/actions/shopify';

/**
 * "Pull the last 30 days" — how a store's history gets in, and how a new
 * store gets any history at all.
 *
 * Two steps on purpose, shown as they happen. The pull creates the parcels;
 * the sweep then asks Correos about every one of them. Both are bounded by the
 * same function limit, so running the sweep inside the pull would give it
 * whatever seconds the pull left over — none, on a thousand parcels. And
 * without the sweep they would sit in Pre-admission for up to three hours,
 * which for a parcel already waiting at a post office is three hours of a
 * countdown nobody can see.
 *
 * Safe to press twice: shipping codes are unique, so a second press reports
 * everything as already there.
 */
export function ShopifyPull({
  storeKey, storeName, windowDays,
}: { storeKey: string; storeName: string; windowDays: number }) {
  const [step, setStep] = useState<'idle' | 'pulling' | 'sweeping' | 'done'>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function run(): void {
    setError(null);
    setLines([]);

    start(async () => {
      setStep('pulling');
      const pulled = await pullShopifyHistory(storeKey);

      if (!pulled.ok || !pulled.report) {
        setError(pulled.error ?? 'The pull did not finish.');
        setStep('idle');
        return;
      }

      const r = pulled.report;
      const said = [
        `${r.checked} orders checked across ${r.pages} ${r.pages === 1 ? 'page' : 'pages'}`,
        `${r.added} ${r.added === 1 ? 'parcel' : 'parcels'} added`,
        `${r.alreadyHad} already here`,
        `${r.notCorreos} not Correos`,
      ];
      if (r.outsideWindow) said.push(`${r.outsideWindow} posted before the window`);
      if (r.stoppedEarly) said.push(`stopped early: ${r.stoppedEarly}`);
      setLines(said);

      if (r.added === 0) { setStep('done'); router.refresh(); return; }

      setStep('sweeping');
      const swept = await sweepPulledParcels();
      if (!swept.ok) {
        setError(`${swept.error} The parcels are in — the three-hourly sweep will pick them up.`);
      } else {
        const asked = Number(swept.detail?.asked ?? 0);
        setLines([...said, `${asked} asked of Correos, so the new parcels show their real status`]);
      }

      setStep('done');
      router.refresh();
    });
  }

  const busy = pending || step === 'pulling' || step === 'sweeping';

  return (
    <div className="border-b border-line px-[14px] py-[11px]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] font-semibold text-ink">{storeName}</span>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded border border-navy px-[11px] py-[7px] text-[12px] font-semibold text-navy disabled:opacity-50"
        >
          {step === 'pulling' ? 'Asking Shopify…'
            : step === 'sweeping' ? 'Asking Correos…'
              : `Pull the last ${windowDays} days`}
        </button>
        {step === 'done' && !error && (
          <span className="text-[12px] font-semibold text-good">Done</span>
        )}
      </div>

      {lines.length > 0 && (
        <ul className="mt-[7px] list-inside list-disc text-[12px] leading-[1.55] text-muted">
          {lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}

      {error && <div className="mt-[7px] text-[12px] font-semibold text-crit">{error}</div>}

      {step === 'idle' && (
        <div className="mt-[6px] max-w-[560px] text-[11.5px] leading-[1.5] text-muted">
          Reads every page of the last {windowDays} days and adds any Correos parcel that is
          missing. Nothing older, because the nightly cleanup would delete it the same night.
          Safe to press twice, and this is also how a new shop gets its history.
        </div>
      )}
    </div>
  );
}
