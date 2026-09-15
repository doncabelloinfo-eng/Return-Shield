import { cronRoute } from '@/lib/cron';
import { importReminder } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

export const GET = cronRoute('import-reminder', importReminder, { onlyAtMadridHour: 9 });
