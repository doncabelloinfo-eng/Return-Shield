import { cronRoute } from '@/lib/cron';
import { staleDetector } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = cronRoute('stale-detector', staleDetector, { onlyAtMadridHour: 7 });
