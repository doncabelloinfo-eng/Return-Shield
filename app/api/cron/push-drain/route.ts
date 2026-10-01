import { cronRoute } from '@/lib/cron';
import { drainPushInbox } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
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
