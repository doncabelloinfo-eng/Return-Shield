import { cronRoute } from '@/lib/cron';
import { drainPushInbox } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Turns staged Correos payloads into events.
 *
 * The receiver returns 200 and writes the raw body; until this runs, a
 * countdown has not started. It is the one job where being a minute late is
 * visible, so it runs every minute.
 */
export const GET = cronRoute('push-drain', () => drainPushInbox());
