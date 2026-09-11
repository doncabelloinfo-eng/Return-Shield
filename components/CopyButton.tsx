'use client';

import { useToast } from './Toast';

/**
 * Step 1 is copy-and-paste, so this button is the product. It never silently
 * fails: if the clipboard is blocked the text is selected instead, and the
 * toast says so rather than claiming success.
 */
export function CopyButton({
  text, said, children, className,
}: { text: string; said: string; children: React.ReactNode; className?: string }) {
  const toast = useToast();

  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast({ text: said });
        } catch {
          toast({ text: 'Could not reach the clipboard — the message is on the parcel page to copy by hand.' });
        }
      }}
    >
      {children}
    </button>
  );
}
