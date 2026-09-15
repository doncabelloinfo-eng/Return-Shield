import { cronRoute } from '@/lib/cron';
import { shopifyBackfill } from '@/jobs/definitions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export const GET = cronRoute('shopify-backfill', shopifyBackfill);
