import { cronRoute } from '@/lib/cron';
import { rebuildPostcodeStats } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export const GET = cronRoute('postcode-stats', rebuildPostcodeStats);
