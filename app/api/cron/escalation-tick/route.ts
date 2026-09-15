import { cronRoute } from '@/lib/cron';
import { escalationTick } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = cronRoute('escalation-tick', escalationTick);
