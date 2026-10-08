import { cronRoute } from '@/lib/cron';
import { staleDetector } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/*
 * `fetchCache = 'force-no-store'` is the second half of the fix for the day
 * tracking silently stopped: it makes every fetch in this route uncacheable
 * whether or not the call site remembers to say so. `dynamic` governs
 * rendering and did not prevent it. See lib/carriers/correos/trackpub.ts.
 */
export const fetchCache = 'force-no-store';
export const maxDuration = 60;

export const GET = cronRoute('stale-detector', staleDetector, { dailyAfterMadridHour: 7, maxDurationSeconds: 60 });
