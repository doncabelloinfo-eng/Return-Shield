'use client';

import { useId, useState } from 'react';

/**
 * A password box with a Show button, from image 1.
 *
 * It is a client component for the one line of state it holds. On a phone, in a
 * warehouse, with a password somebody read out of a Settings screen, being able
 * to see what has been typed is the difference between signing in and typing it
 * four times — and a worker holding a parcel cannot debug a wrong character.
 */
export function PasswordField({ name = 'password' }: { name?: string }) {
  const [shown, setShown] = useState(false);
  const id = useId();

  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">Password</label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={shown ? 'text' : 'password'}
          required
          placeholder="Your password"
          autoComplete="current-password"
          className="h-[52px] w-full rounded-[10px] border border-line bg-surface pl-[14px] pr-[76px] text-[16px] text-ink"
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          className="absolute right-[6px] top-[6px] h-[40px] rounded-[8px] bg-surface2 px-3 text-[14px] font-semibold text-navy"
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}
