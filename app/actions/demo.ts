'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/guard';
import { getSetting, setSetting } from '@/lib/settings';
import { say } from '@/lib/activity';
import { demoNow, isDemoMode } from '@/lib/demo-clock';
import { runTick } from '@/lib/escalation/run';
import { liveShipmentIds } from '@/lib/shipments/repo';

/**
 * The time machine, kept for the two things it is genuinely worth keeping for:
 * showing the system to somebody without pointing it at real customers, and
 * walking a fortnight of escalation in ten seconds when something looks wrong.
 *
 * It refuses to run unless DEMO_MODE is on, and DEMO_MODE is never on in
 * production — the clock is not something a business should be able to move.
 */

function assertDemo(): void {
  if (!isDemoMode()) {
    throw new Error('The clock can only be moved with DEMO_MODE=1. This is not a demo instance.');
  }
}

export async function advanceDemoClock(minutes: number) {
  await requireUser();
  assertDemo();

  const offset = await getSetting('demoClockOffsetMinutes');
  await setSetting('demoClockOffsetMinutes', offset + minutes);

  // Moving the clock is only interesting if the ladder moves with it.
  await runTick(await liveShipmentIds(), demoNow());

  revalidatePath('/', 'layout');
}

export async function resetDemo() {
  await requireUser();
  assertDemo();

  await setSetting('demoClockOffsetMinutes', 0);
  await say('Clock put back to now');
  revalidatePath('/', 'layout');
}
