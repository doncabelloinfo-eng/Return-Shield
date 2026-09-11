'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * The line at the bottom that says what just happened, and offers to undo it.
 *
 * It stays for ten seconds rather than three: the undo is the point, and an
 * undo that has gone by the time you have read the sentence is not an undo.
 */

interface ToastState { text: string; undo?: () => void | Promise<void> }

const Ctx = createContext<(t: ToastState) => void>(() => {});

export function useToast() { return useContext(Ctx); }

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((t: ToastState) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(t);
    timer.current = setTimeout(() => setToast(null), 10_000);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <Ctx.Provider value={show}>
      {children}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-4 z-[60] flex max-w-[min(460px,92vw)] items-center gap-[14px] rounded-md bg-navy px-[14px] py-3 text-white shadow-toast"
        >
          <span className="text-[13px] font-medium leading-[1.4]">{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={async () => { await toast.undo!(); setToast(null); }}
              className="ml-auto whitespace-nowrap rounded border border-accent px-3 py-[7px] text-[12px] font-bold text-accent"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}
