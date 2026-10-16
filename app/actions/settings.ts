'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { requireUser } from '@/lib/auth/guard';

/**
 * What is left of the Settings actions.
 *
 * There were three more, and all three are gone because what they changed was
 * never real:
 *
 * `setDepositDays` and `markDepositConfirmed` edited "how long the post office
 * waits" per Correos service — a number that started at 15, was labelled
 * "still a guess", and was the basis of every deadline, countdown and "goes
 * back on" date in the system, including the dates in customers' messages.
 * Correos does not publish it, does not send it, and announces the return
 * itself when it happens. So the window is gone rather than editable, the
 * `product_rules` rows are left in place unread, and nothing invents a date.
 *
 * `setPhase` flipped the Step 1 / Step 2 switch in the top bar. Step 2 needs a
 * WhatsApp provider that can send, and `WHATSAPP_PROVIDER` is `none`, so the
 * switch changed a stored number and nothing else — it was pressed several
 * times on 7 October to see what it did, and it did nothing. The code path is
 * still there in `lib/escalation/run.ts` for when a provider is connected; the
 * control is not.
 */

/**
 * `requireUser` even for a cookie.
 *
 * It had no guard, on the reasoning that the control lives in a top bar only
 * operators ever see and all it sets is a theme. Both halves are true and
 * neither is the point: a server action is a public endpoint whatever the page
 * around it looks like, and "every panel action refuses a scanner session" is
 * only worth testing if it holds for all of them. One exception is how a rule
 * stops being a rule.
 */
export async function toggleTheme(next: 'light' | 'dark') {
  await requireUser();
  cookies().set('rs_theme', next, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  revalidatePath('/', 'layout');
}
