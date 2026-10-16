'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addWorker, setWorkerActive, setWorkerPassword } from '@/app/actions/scanner';
import { Card } from './ui';

/**
 * Settings → Scanner accounts.
 *
 * The warehouse has no email to invite and no password reset to click: the
 * operator types a password, reads it out, and can set a new one. For a handful
 * of people who work in the same building that is the whole of what is needed,
 * and it avoids a reset flow nobody would use twice a year.
 *
 * NO BROWSER `confirm()` ANYWHERE, by the operator's instruction. Disabling is
 * one press because it is reversible with one press — the Enable button is in
 * the same place. Setting a password opens a field on the row rather than a
 * dialog, so whoever is doing it can see which worker they are changing while
 * they type.
 */

export interface WorkerLine {
  id: string;
  name: string;
  email: string;
  active: boolean;
  /** "2 days ago", or "never". Formatted on the server. */
  lastScan: string;
  lastScanExact: string;
}

export function ScannerAccounts({ workers }: { workers: WorkerLine[] }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function add(form: FormData): void {
    setError(null);
    setSaid(null);
    start(async () => {
      const answer = await addWorker(form);
      if (!answer.ok) {
        setError(answer.error ?? 'That worker could not be added.');
        return;
      }
      setAdding(false);
      setSaid(`${String(form.get('name') ?? '').trim()} can sign in at /scan/login now.`);
      router.refresh();
    });
  }

  function toggle(id: string, active: boolean): void {
    setError(null);
    setSaid(null);
    start(async () => {
      const answer = await setWorkerActive(id, active);
      if (!answer.ok) setError(answer.error ?? 'That did not work.');
      else {
        setSaid(active
          ? 'Signed back in from now on.'
          : 'Disabled, and signed out of every phone at once.');
        router.refresh();
      }
    });
  }

  return (
    <Card
      title="Scanner accounts"
      note="the warehouse phones · they can reach /scan and nothing else"
    >
      {workers.length === 0 && (
        <div className="border-b border-line px-[14px] py-[11px] text-[12.5px] leading-[1.55] text-muted">
          No warehouse accounts yet. Add one here, then give the worker the email and password
          and send them to <span className="font-mono">/scan/login</span> on their phone — or to{' '}
          <span className="font-mono">/login</span>, where <b>Login as Scanner</b> takes them to
          the same place.
        </div>
      )}

      {workers.map((w) => (
        <Worker key={w.id} worker={w} pending={pending} onToggle={toggle} onError={setError} onSaid={setSaid} />
      ))}

      <div className="border-b border-line px-[14px] py-[11px]">
        {adding ? (
          <form action={add} className="flex flex-col gap-[10px]">
            <div className="flex flex-wrap gap-[10px]">
              <label className="flex flex-col gap-[4px]">
                <span className="text-[11px] font-semibold text-ink">Name</span>
                <input
                  name="name" required autoFocus
                  className="w-[160px] rounded border border-line bg-surface2 px-3 py-[8px] text-[12.5px] text-ink"
                />
              </label>
              <label className="flex flex-col gap-[4px]">
                <span className="text-[11px] font-semibold text-ink">Email</span>
                <input
                  name="email" type="email" required autoComplete="off"
                  className="w-[220px] rounded border border-line bg-surface2 px-3 py-[8px] text-[12.5px] text-ink"
                />
              </label>
              <label className="flex flex-col gap-[4px]">
                <span className="text-[11px] font-semibold text-ink">Password</span>
                <input
                  name="password" type="text" required minLength={8} autoComplete="off"
                  className="w-[200px] rounded border border-line bg-surface2 px-3 py-[8px] font-mono text-[12.5px] text-ink"
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={pending}
                className="rounded border border-navy bg-navy px-[11px] py-[7px] text-[12px] font-semibold text-white disabled:opacity-50"
              >
                {pending ? 'Adding…' : 'Add worker'}
              </button>
              <button
                type="button"
                onClick={() => { setAdding(false); setError(null); }}
                className="rounded border border-line px-[11px] py-[7px] text-[12px] font-semibold text-ink"
              >
                Cancel
              </button>
              {/*
                Shown as text, not a password field: the operator is going to
                read it out to somebody standing next to them, and a row of
                dots they cannot check is how a worker ends up unable to sign
                in with a password that was typed correctly.
              */}
              <span className="text-[11.5px] text-muted">
                At least 8 characters. Shown as you type, so you can read it out.
              </span>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => { setAdding(true); setSaid(null); }}
            className="rounded border border-line px-[11px] py-[7px] text-[12px] font-semibold text-ink"
          >
            Add a worker
          </button>
        )}
      </div>

      {error && (
        <div className="border-b border-line px-[14px] py-[9px] text-[12px] font-semibold text-crit">
          {error}
        </div>
      )}
      {said && (
        <div className="border-b border-line px-[14px] py-[9px] text-[12px] font-semibold text-good">
          {said}
        </div>
      )}

      <div className="px-[14px] py-3 text-[11.5px] leading-[1.5] text-muted">
        A Scanner account can reach <span className="font-mono">/scan</span> and the few
        requests behind it, and no panel page, action or API route. It never sees a customer
        name, phone or address — the scanner is only ever sent a code, an order number and a
        shop.
      </div>
    </Card>
  );
}

function Worker({
  worker, pending, onToggle, onError, onSaid,
}: {
  worker: WorkerLine;
  pending: boolean;
  onToggle: (id: string, active: boolean) => void;
  onError: (message: string | null) => void;
  onSaid: (message: string | null) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, start] = useTransition();

  function save(): void {
    onError(null);
    onSaid(null);
    start(async () => {
      const answer = await setWorkerPassword(worker.id, password);
      if (!answer.ok) {
        onError(answer.error ?? 'That password could not be set.');
        return;
      }
      setChanging(false);
      setPassword('');
      onSaid(`New password set for ${worker.name}. Their phones have been signed out.`);
    });
  }

  return (
    <div className="border-b border-line px-[14px] py-[11px]">
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px]">
        <span className="text-[12.5px] font-semibold text-ink">{worker.name}</span>
        <span className="font-mono text-[12px] text-muted">{worker.email}</span>

        <span
          className="rounded-[3px] border px-[6px] py-[2px] text-[10.5px] font-semibold"
          style={worker.active
            ? { borderColor: 'var(--good)', background: 'var(--goodsoft)', color: 'var(--good)' }
            : { borderColor: 'var(--line)', background: 'var(--surface2)', color: 'var(--muted)' }}
        >
          {worker.active ? 'Active' : 'Disabled'}
        </span>

        <span className="text-[11.5px] text-muted" title={worker.lastScanExact}>
          last scan {worker.lastScan}
        </span>

        <span className="ml-auto flex gap-[6px]">
          <button
            type="button"
            onClick={() => { setChanging((c) => !c); onError(null); onSaid(null); }}
            disabled={pending || busy}
            className="rounded border border-line px-[11px] py-[6px] text-[12px] font-semibold text-ink disabled:opacity-50"
          >
            {changing ? 'Cancel' : 'Set a new password'}
          </button>
          <button
            type="button"
            onClick={() => onToggle(worker.id, !worker.active)}
            disabled={pending || busy}
            className="rounded border px-[11px] py-[6px] text-[12px] font-semibold disabled:opacity-50"
            style={worker.active
              ? { borderColor: 'var(--crit)', color: 'var(--crit)' }
              : { borderColor: 'var(--good)', color: 'var(--good)' }}
          >
            {worker.active ? 'Disable' : 'Enable'}
          </button>
        </span>
      </div>

      {changing && (
        <div className="mt-[9px] flex flex-wrap items-center gap-2">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="text"
            minLength={8}
            autoFocus
            autoComplete="off"
            placeholder="New password"
            aria-label={`New password for ${worker.name}`}
            className="w-[220px] rounded border border-line bg-surface2 px-3 py-[8px] font-mono text-[12.5px] text-ink"
          />
          <button
            type="button"
            onClick={save}
            disabled={busy || password.length < 8}
            className="rounded border border-navy bg-navy px-[11px] py-[7px] text-[12px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <span className="text-[11.5px] text-muted">
            This signs {worker.name} out of every phone.
          </span>
        </div>
      )}
    </div>
  );
}
