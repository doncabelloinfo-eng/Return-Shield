import { setClock, resetClock } from './clock';
import { getSetting } from './settings';

/**
 * Demo mode's clock offset lives in the database rather than in memory,
 * because the web process and the job worker have to agree about what time it
 * is. An offset held in one process would have the dashboard showing a
 * fortnight from now while the worker fired reminders for today.
 */

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === '1';
}

let offsetMs = 0;

/** Read the stored offset and install it. Call once per request in demo mode. */
export async function loadDemoClock(): Promise<void> {
  if (!isDemoMode()) return;
  const minutes = await getSetting('demoClockOffsetMinutes');
  offsetMs = minutes * 60_000;
  if (offsetMs === 0) { resetClock(); return; }
  setClock(() => new Date(Date.now() + offsetMs));
}

export function demoNow(): Date {
  return new Date(Date.now() + offsetMs);
}
