import { cronRoute } from '@/lib/cron';
import { pushHeartbeat } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

export const GET = cronRoute('push-heartbeat', pushHeartbeat);
