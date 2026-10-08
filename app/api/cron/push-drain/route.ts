import { cronRoute } from '@/lib/cron';
import { drainPushInbox } from '@/jobs/definitions';

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

/**
 * Turns staged Correos payloads into events.
 *
 * The receiver returns 200 and writes the raw body; until this runs, a
 * countdown has not started — so when push is in use, being late here is
 * visible. Push is NOT in use at the moment (tracking runs on trackpub only),
 * so it returns immediately and the schedule is every five minutes rather than
 * every minute. Turn push on and this is the first number to put back.
 */
export const GET = cronRoute('push-drain', () => drainPushInbox(), { maxDurationSeconds: 60 });
