'use client';

import { useState, useTransition } from 'react';

interface Option { key: string; label: string; primary: boolean; good?: boolean }

const OPTIONS: readonly Option[] = [
  { key: 'ok_address', label: 'Mi dirección es correcta', primary: true },
  { key: 'change_address', label: 'Quiero cambiar la dirección', primary: false },
  { key: 'cant_go', label: 'No puedo ir, reenviadlo', primary: false },
  { key: 'call_me', label: 'Llamadme', primary: false, good: true },
];

/**
 * Four link buttons, never a reply box.
 *
 * The number the message came from cannot receive replies. A reply box here
 * would be the same trap in a different place: it would let somebody think
 * they had told us something when nobody was listening.
 */
export function CustomerActions({
  token, firstName, storeName,
}: { token: string; firstName: string; storeName: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (done) {
    return (
      <div className="mt-4 rounded-md border border-[#0E7C56] bg-[#EAF5F0] px-4 py-3">
        <div className="text-[13px] font-semibold text-[#0E7C56]">¡Gracias{firstName ? `, ${firstName}` : ''}! Ya lo tenemos.</div>
        <div className="mt-1 text-[12px] leading-[1.5]">
          Lo hemos registrado y {storeName} se encarga. No hace falta que hagas nada más.
        </div>
      </div>
    );
  }

  const tap = (action: string) => start(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/actions/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) { setDone(true); return; }
      const body = await res.json().catch(() => ({}));
      setError(body.message ?? 'No hemos podido registrarlo. Inténtalo de nuevo en un momento.');
    } catch {
      setError('No hay conexión. Inténtalo de nuevo en un momento.');
    }
  });

  return (
    <div className="mt-4">
      <div className="text-[12px] font-semibold text-[#5A6478]">¿Qué prefieres?</div>
      <div className="mt-2 flex flex-col gap-[7px]">
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            disabled={pending}
            onClick={() => tap(o.key)}
            className="w-full rounded-md border px-4 py-3 text-left text-[13px] font-semibold disabled:opacity-60"
            style={{
              borderColor: o.good ? '#0E7C56' : '#10203D',
              background: o.primary ? '#10203D' : '#fff',
              color: o.primary ? '#fff' : (o.good ? '#0E7C56' : '#10203D'),
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      {error && (
        <div className="mt-3 rounded border border-[#B3261E] bg-[#FBECEA] px-3 py-2 text-[12px] text-[#B3261E]">
          {error}
        </div>
      )}
    </div>
  );
}
