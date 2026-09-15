import { cronRoute } from '@/lib/cron';
import { dailyDigest } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = cronRoute('daily-digest', dailyDigest, { onlyAtMadridHour: 8 });
