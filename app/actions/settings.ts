'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { productRules } from '@/db/schema';
import { requireUser } from '@/lib/auth/guard';
import { recalculateDeadlines } from '@/lib/shipments/repo';
import { setSetting } from '@/lib/settings';
import { say } from '@/lib/activity';
import { now } from '@/lib/clock';

/**
 * The deposit window. Change it and every deadline, countdown and reminder is
 * worked out again straight away — including the ones that are now in the past,
 * which is exactly what happens in real life when Correos changes how long
 * they hold things.
 */
export async function setDepositDays(productCode: string, days: number) {
  await requireUser();
  const clamped = Math.max(1, Math.min(30, Math.round(days)));

  await db.update(productRules)
    .set({ depositDays: clamped, updatedAt: now() })
    .where(eq(productRules.productCode, productCode));

  const moved = await recalculateDeadlines(productCode);
  await say(`Waiting time for ${productCode} changed to ${clamped} days — ${moved} parcels worked out again`);
  revalidatePath('/', 'layout');
}

export async function markDepositConfirmed(productCode: string, confirmed: boolean) {
  await requireUser();
  await db.update(productRules)
    .set({ confirmedWithCarrier: confirmed, updatedAt: now() })
    .where(eq(productRules.productCode, productCode));
  revalidatePath('/', 'layout');
}

/** Step 1 writes the messages; Step 2 sends them. */
export async function setPhase(phase: 1 | 2) {
  await requireUser();
  await setSetting('phase', phase);
  await say(phase === 1
    ? 'Back to Step 1 — the system writes the messages, you send them'
    : 'Now on Step 2 — the system sends the messages itself and only calls you in if nobody replies');
  revalidatePath('/', 'layout');
}

export async function toggleTheme(next: 'light' | 'dark') {
  cookies().set('rs_theme', next, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  revalidatePath('/', 'layout');
}
