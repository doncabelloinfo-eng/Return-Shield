'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useCallback } from 'react';
import { BusyDatabase } from '@/components/BusyDatabase';

/**
 * The boundary for everything below the root layout, and the one that matters.
 *
 * `app/(panel)/error.tsx` catches a page. It cannot catch the LAYOUT that page
 * sits in — Next sends a layout's error to the parent segment's boundary — and
 * the panel layout is where `requireUser()` runs the session lookup that is
 * behind digest 3880840699, along with the activity, engine-health and to-do
 * reads. So the error the operator hits most landed here, and with no
 * `app/error.tsx` it fell all the way through to `global-error`, which
 * replaces the whole document: no stylesheet, no theme, and a reload the only
 * way out.
 *
 * With this file it is an ordinary styled page inside the root layout, it asks
 * the server again by itself, and it comes back on its own when the database
 * does. `global-error` stays as the last resort for an error in the root
 * layout itself.
 */
export default function RootError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  const retry = useCallback(() => {
    // `reset()` alone re-renders the failed payload. `router.refresh()` is the
    // part that goes back to the server. See app/(panel)/error.tsx.
    startTransition(() => {
      router.refresh();
      reset();
    });
  }, [router, reset]);

  return (
    <div className="min-h-screen bg-ground text-ink">
      <BusyDatabase digest={error.digest} onRetry={retry} />
    </div>
  );
}
