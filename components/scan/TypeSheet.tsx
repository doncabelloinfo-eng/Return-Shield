'use client';

import { useState } from 'react';
import { parseCorreosCode, readsAs } from '@/lib/scan/codes';
import { CrossIcon } from './icons';

/**
 * "Type the number" — image 7, for the label the camera will not read.
 *
 * It takes either printed number, because a worker reading a damaged label
 * takes whichever one is legible: the 16-character EXPEDICIÓN or the
 * 23-character Código de Bulto. The "Reads as" box breaks down what has been
 * typed WHILE it is being typed, which is the whole point of it — a worker who
 * has mistyped one character sees the expedición change under their thumb,
 * rather than finding out when the batch is finished.
 *
 * "Add to batch" is refused until the number parses. A code that cannot be
 * parsed cannot be matched or looked up later either, so storing it would only
 * put a row in the pile that nobody can ever do anything with.
 */
export function TypeSheet({
  onAdd,
  onClose,
}: {
  onAdd: (code: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const code = parseCorreosCode(typed);
  const enough = typed.replace(/[^A-Za-z0-9]/g, '').length > 0;

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-[rgba(6,10,20,.62)]"
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code) onAdd(code.raw);
        }}
        className="flex flex-col gap-4 rounded-t-[20px] bg-surface px-5 pb-7 pt-[10px] shadow-menu"
      >
        <span aria-hidden="true" className="h-1 w-10 self-center rounded-[2px] bg-line" />

        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[22px] font-semibold tracking-[-.01em] text-ink">
              Type the number
            </h2>
            <p className="m-0 text-[14px] leading-[1.45] text-muted">
              Use the EXPEDICIÓN number or the Código de Bulto printed on the label.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-11 w-11 flex-none place-items-center rounded-full bg-surface2 text-ink"
          >
            <CrossIcon />
          </button>
        </div>

        <div className="flex flex-col gap-[6px]">
          <label htmlFor="type-code" className="text-[13px] font-semibold text-ink">
            Number on the label
          </label>
          <input
            id="type-code"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            // `text` and not a number keyboard: the codes are letters and
            // digits together, and a numeric pad cannot type PKA6TP.
            inputMode="text"
            placeholder="PKA6TP980010152E"
            className="h-[58px] w-full rounded-[10px] border-2 border-navy bg-surface px-[14px] font-mono text-[20px] font-medium tracking-[.04em] text-ink"
          />
          {enough && (
            <span
              className={`text-[13px] font-semibold ${code ? 'text-good' : 'text-warn'}`}
              role="status"
            >
              {code
                ? readsAs(code)
                : 'Not a Correos number yet. 16 characters for the EXPEDICIÓN, 23 for the Código de Bulto.'}
            </span>
          )}
        </div>

        {code && (
          <div className="flex flex-col gap-2 rounded-[10px] bg-surface2 px-[14px] py-3">
            <span className="text-[11px] font-semibold uppercase tracking-[.09em] text-ink">
              Reads as
            </span>
            <Line name="Expedición" value={code.base} />
            {code.parcelNo && <Line name="Parcel number" value={code.parcelNo} />}
            {code.postalCode && <Line name="Postal code" value={code.postalCode} />}
            {code.checkLetter && <Line name="Check letter" value={code.checkLetter} />}
          </div>
        )}

        <div className="grid grid-cols-2 gap-[10px]">
          <button
            type="button"
            onClick={onClose}
            className="flex h-[54px] items-center justify-center rounded-[10px] border border-line bg-surface text-[16px] font-semibold text-navy"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!code}
            className="flex h-[54px] items-center justify-center rounded-[10px] bg-navy text-[16px] font-semibold text-white disabled:opacity-40"
          >
            Add to batch
          </button>
        </div>
      </form>
    </div>
  );
}

function Line({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-[14px]">
      <span className="text-muted">{name}</span>
      <span className="font-mono font-medium text-ink">{value}</span>
    </div>
  );
}
