'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import type { PreviewRow } from '@/lib/import/parse';
import { confirmUpload, previewUpload, type PreviewResult } from '@/app/actions/import';
import { sweepNewParcels } from '@/app/actions/refresh';
import { isAcceptableFix } from '@/lib/import/phone';
import { useToast } from './Toast';
import { Chip, Th } from './ui';

/**
 * Upload, look, confirm.
 *
 * The preview is the point. Everything that could be fixed without guessing
 * has been, and is shown with what it used to be so the fix can be checked.
 * The ones that could not are red, at the top of their row's attention, with
 * the box to type the right number in exactly where the wrong one was.
 */
export function ImportScreen() {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [fixes, setFixes] = useState<Record<number, string>>({});
  const [pending, start] = useTransition();
  /** The Correos check that follows a confirmed upload. See the button below. */
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const toast = useToast();

  const upload = (file: File) => {
    const form = new FormData();
    form.set('file', file);
    start(async () => {
      setFixes({});
      setResult(await previewUpload(form));
    });
  };

  if (!result?.ok) {
    return (
      <div className="mt-[18px]">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) upload(f);
          }}
          className="rounded-md border-2 border-dashed border-line bg-surface p-8 text-center"
        >
          <div className="text-[14.5px] font-semibold text-ink">Drop a TikTok or Amazon file here</div>
          <div className="mt-[5px] text-[12.5px] leading-[1.5] text-muted">
            The shipping-confirmation export, as it comes — <span className="font-mono">.txt</span>,{' '}
            <span className="font-mono">.csv</span>, <span className="font-mono">.tsv</span> or{' '}
            <span className="font-mono">.xlsx</span>. Each row says which marketplace it is from, so
            one file can hold both.<br />
            Nothing is added until you have looked at what it found.
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => input.current?.click()}
            className="mt-4 rounded bg-navy px-[15px] py-[10px] text-[12.5px] font-semibold text-white disabled:opacity-60"
          >
            {pending ? 'Checking the file…' : 'Choose a file'}
          </button>
          <input
            ref={input}
            type="file"
            accept=".txt,.csv,.tsv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
          />
        </div>

        {result && !result.ok && (
          <div className="mt-3 rounded-[5px] border border-crit bg-critsoft px-4 py-3 text-[12.5px] leading-[1.5] text-crit">
            <strong>{result.error}</strong>
            {result.missingColumns?.length ? (
              <div className="mt-1 text-ink">
                A shipping-confirmation export needs{' '}
                <span className="font-mono">order-id, tracking-number, ship-date</span> and a
                carrier column. A full export needs{' '}
                <span className="font-mono">order_id, customer_name, phone, address, city,
                postal_code, shipping_code, order_value, payment_method, shipped_at</span>. Header
                names are matched loosely, so a renamed column is usually still found — these ones
                were not.
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  const rows = result.rows ?? [];
  const s = result.summary!;
  const fixedNow = rows.filter((r) => r.status === 'needs_you' && isAcceptableFix(fixes[r.n] ?? '')).length;
  const stillBroken = s.needsYou - fixedNow;

  return (
    <div>
      <div className="mt-[14px] text-[12.5px] text-muted">
        Checked <span className="font-mono text-ink">{result.filename}</span> · {result.sizeLabel}
      </div>

      <div className="mt-3 flex flex-wrap overflow-hidden rounded-[5px] border border-line bg-surface">
        <Stat n={s.total} label="Rows in the file" colour="var(--ink)" />
        <Stat n={s.new} label="New orders" colour="var(--good)" />
        <Stat n={s.duplicate} label="Already had these" colour="var(--muted)" />
        <Stat n={stillBroken} label="Need you" colour={stillBroken ? 'var(--crit)' : 'var(--muted)'} />

        {/* "82 TikTok · 1 Amazon". Worked out per row from the order id, never
            from the file name — one of these files was called "tiktok shop.txt"
            and people rename them. */}
        {s.bySource.length > 0 && (
          <div className="flex min-w-[200px] flex-1 items-center px-[18px] py-[14px] text-[12.5px] leading-[1.5] text-ink">
            <span>
              <strong>{s.bySource.map((b) => `${b.count} ${b.label}`).join(' · ')}</strong>
              <br />
              <span className="text-muted">worked out from each order number</span>
            </span>
          </div>
        )}

        {result.format === 'tracking' ? (
          <div className="flex min-w-[250px] flex-1 items-center px-[18px] py-[14px] text-[12.5px] leading-[1.5] text-muted">
            <span>
              This file carries no names, phones or addresses — that is normal for a
              shipping-confirmation export, so a missing phone is not an error here. Contact
              goes through the marketplace.
              {s.notCorreos > 0 && (
                <>
                  <br />
                  <strong className="text-ink">{s.notCorreos} skipped: not Correos.</strong>
                </>
              )}
            </span>
          </div>
        ) : (
          <div className="flex min-w-[230px] flex-1 items-center bg-goodsoft px-[18px] py-[14px] text-[12.5px] leading-[1.5] text-ink">
            <span>
              <strong className="text-good">Fixed {s.autofixed} phone numbers automatically.</strong>{' '}
              Added +34 where it was missing, stripped spaces and dashes, turned 0034 into +34.
              {stillBroken > 0 && ` ${stillBroken} ${stillBroken === 1 ? 'is' : 'are'} left that nobody can guess.`}
            </span>
          </div>
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-[5px] border border-line bg-surface">
        <table>
          <thead>
            <tr>
              <Th align="right">Row</Th>
              <Th>From</Th>
              <Th>Customer</Th>
              <Th>Phone</Th>
              <Th align="right">Value</Th>
              <Th>Town</Th>
              <Th>What happened</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ImportRow
                key={r.n}
                row={r}
                fix={fixes[r.n] ?? ''}
                onFix={(v) => setFixes((f) => ({ ...f, [r.n]: v }))}
              />
            ))}
          </tbody>
        </table>

        <div className="flex flex-wrap items-center gap-[14px] px-[14px] py-[13px]">
          <span className="text-[12.5px] text-muted">
            {stillBroken > 0
              ? `The ${stillBroken} ${stillBroken === 1 ? 'number' : 'numbers'} nobody can guess come in without reminders unless you fix them here.`
              : 'Every number in this file can be messaged.'}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => { setResult(null); setFixes({}); }}
              className="rounded border border-line bg-surface px-[15px] py-[10px] text-[12.5px] font-semibold text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending || checking}
              onClick={() => start(async () => {
                const r = await confirmUpload(result.filename!, rows, fixes);
                setResult(null);
                setFixes({});
                toast({ text: `${r.created} orders added. ${r.fixed} phone numbers fixed automatically.` });

                /*
                 * Then ask Correos about them, the same way the Shopify
                 * history pull does — a second request, because both are
                 * bounded by the same function limit.
                 *
                 * Without this the new parcels sit in Pre-admission until the
                 * next scheduled sweep, up to three hours later. The eighty-one
                 * TikTok parcels uploaded on 7 October did exactly that, and
                 * any of them already waiting at a post office spent those
                 * hours invisible.
                 */
                if (r.created > 0) {
                  setChecking(true);
                  try {
                    const swept = await sweepNewParcels();
                    toast({
                      text: swept.ok
                        ? `${Number(swept.detail?.asked ?? 0)} asked of Correos, so the new parcels show their real status.`
                        : `${swept.error} They are in — the three-hourly sweep will pick them up.`,
                    });
                  } finally {
                    setChecking(false);
                  }
                }

                router.refresh();
              })}
              className="rounded bg-navy px-[17px] py-[10px] text-[12.5px] font-semibold text-white disabled:opacity-60"
            >
              {checking ? 'Asking Correos…' : pending ? 'Adding…' : `Add ${s.new} orders`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ n, label, colour }: { n: number; label: string; colour: string }) {
  return (
    <div className="min-w-[120px] border-r border-line px-5 py-[14px]">
      <div className="tnum font-display text-[27px] font-bold leading-none" style={{ color: colour }}>{n}</div>
      <div className="mt-[2px] text-[11.5px] font-medium text-muted">{label}</div>
    </div>
  );
}

function ImportRow({
  row, fix, onFix,
}: { row: PreviewRow; fix: string; onFix: (v: string) => void }) {
  const mended = isAcceptableFix(fix);
  const broken = row.status === 'needs_you' && !mended;
  const wasFixed = row.phone.fixes.length > 0;

  return (
    <tr style={{
      background: broken ? 'var(--critsoft)' : row.status === 'duplicate' ? 'var(--surface2)' : 'transparent',
    }}>
      <td
        className="tnum border-b border-line px-3 py-[11px] text-right font-mono text-[12px] text-muted"
        style={{ borderLeft: `4px solid ${broken ? 'var(--crit)' : 'transparent'}` }}
      >
        {row.n}
      </td>

      {/* Which marketplace, per row. A badge rather than a column of text,
          because the useful thing is spotting the odd one out in eighty. */}
      <td className="whitespace-nowrap border-b border-line px-3 py-[11px]">
        <SourceBadge source={row.source} />
      </td>

      <td className="whitespace-nowrap border-b border-line px-3 py-[11px] text-[13px] font-medium text-ink">
        {row.customerName || (
          <span className="font-mono text-[12px] text-muted" title="This export carries no names">
            {row.orderId || '—'}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap border-b border-line px-3 py-[11px]">
        <span className={broken
          ? 'font-mono text-[13px] font-semibold text-crit line-through'
          : 'font-mono text-[12.5px] text-ink'}>
          {row.phone.e164 ?? (row.phone.raw || '—')}
        </span>
        {wasFixed && !broken && (
          <div className="mt-[3px] text-[11px] text-muted">was {row.phone.raw}</div>
        )}
        {row.status === 'needs_you' && (
          <div>
            <div className="mt-1 text-[11px] font-semibold text-crit">{row.error}</div>
            <input
              value={fix}
              onChange={(e) => onFix(e.target.value)}
              placeholder="+34 6XX XXX XXX"
              aria-label={`Correct phone number for row ${row.n}`}
              className="mt-1 w-[160px] rounded-[3px] border bg-surface px-[7px] py-[5px] font-mono text-[12px] text-ink"
              style={{ borderColor: mended ? 'var(--good)' : 'var(--crit)' }}
            />
          </div>
        )}
      </td>
      <td className="tnum border-b border-line px-3 py-[11px] text-right text-[13px] font-medium text-ink">
        €{(row.valueCents / 100).toFixed(2)}
      </td>
      <td className="whitespace-nowrap border-b border-line px-3 py-[11px] text-[12.5px] text-muted">{row.city}</td>
      <td className="whitespace-nowrap border-b border-line px-3 py-[11px]">
        {broken
          ? <Chip colour="var(--crit)" background="var(--surface)">Needs you</Chip>
          : mended
            ? <Chip colour="var(--good)" background="var(--goodsoft)">Fixed by you</Chip>
            : row.status === 'duplicate'
              ? <Chip colour="var(--muted)" background="var(--surface)">Already had</Chip>
              : row.status === 'fixed'
                ? <Chip colour="var(--good)" background="var(--goodsoft)">Number fixed</Chip>
                : <Chip colour="var(--good)" background="var(--surface)">New</Chip>}
      </td>
    </tr>
  );
}

/**
 * Which marketplace a row came from.
 *
 * Grey for the two we recognise and red for the two we do not, because the
 * failure cases are the ones worth seeing: an order number Excel has destroyed
 * cannot be recovered, and one in neither shape cannot be placed.
 */
function SourceBadge({ source }: { source: PreviewRow['source'] }) {
  if (source === 'tiktok' || source === 'amazon') {
    return (
      <span
        className="inline-block rounded-[3px] border px-[6px] py-[2px] text-[10.5px] font-semibold"
        style={{ borderColor: 'var(--line)', background: 'var(--surface2)', color: 'var(--ink)' }}
      >
        {source === 'tiktok' ? 'TikTok' : 'Amazon'}
      </span>
    );
  }

  return (
    <span
      className="inline-block rounded-[3px] border px-[6px] py-[2px] text-[10.5px] font-semibold"
      style={{ borderColor: 'var(--crit)', background: 'var(--critsoft)', color: 'var(--crit)' }}
      title={source === 'excel_damaged'
        ? 'Excel has rewritten this order number in scientific notation. The digits are gone.'
        : 'The order number is in neither the Amazon nor the TikTok shape.'}
    >
      {source === 'excel_damaged' ? 'Excel damage' : "Can't tell"}
    </span>
  );
}
