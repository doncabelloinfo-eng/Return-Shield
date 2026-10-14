'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useCallback } from 'react';
import { BusyDatabase } from '@/components/BusyDatabase';

/**
 * A page under the panel threw. Almost always a refused connection.
 *
 * `reset()` ON ITS OWN DOES NOT RE-FETCH ANYTHING. It re-renders this boundary
 * from the payload that already failed, so the screen stayed on the error page
 * even with the database back up — measured in Chromium against a built
 * server, button included. `router.refresh()` is what asks the server again,
 * and the two go together inside one transition: refresh fetches, reset drops
 * the error so the fresh payload can render.
 *
 * This boundary does NOT catch an error thrown by app/(panel)/layout.tsx —
 * which is where the session lookup runs, and so where the error the operator
 * actually hits comes from. That one is caught by app/error.tsx.
 */
export default function PanelError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  const retry = useCallback(() => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }, [router, reset]);

  return <BusyDatabase digest={error.digest} onRetry={retry} />;
}
