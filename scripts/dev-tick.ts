import 'dotenv/config';
import { getSql, closeDb } from '@/db';
import { runTick } from '@/lib/escalation/run';
import { liveShipmentIds } from '@/lib/shipments/repo';
import { setClock } from '@/lib/clock';
import { isDemoMode } from '@/lib/demo-clock';

/**
 * Run one escalation tick, optionally at a time of your choosing.
 *
 *   npx tsx scripts/dev-tick.ts
 *   npx tsx scripts/dev-tick.ts "2026-09-20T10:00:00+02:00"
 *
 * The second form only works with DEMO_MODE=1 — `setClock` refuses otherwise,
 * which is the point: nothing should be able to move a live business's clock.
 */
async function main(): Promise<void> {
  const when = process.argv[2];

  if (when) {
    if (!isDemoMode()) {
      console.error('A time can only be given with DEMO_MODE=1. Running at the real time instead would');
      console.error('be misleading, so this is a refusal rather than a fallback.');
      process.exit(1);
    }
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) { console.error(`"${when}" is not a date.`); process.exit(1); }
    setClock(() => at);
  }

  const at = when ? new Date(when) : new Date();
  const result = await runTick(await liveShipmentIds(), at);
  console.log(JSON.stringify(result, null, 2));
  await closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
