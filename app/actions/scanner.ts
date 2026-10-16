'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/guard';
import { addScanner, setScannerActive, setScannerPassword } from '@/lib/scan/accounts';
import { say } from '@/lib/activity';

/**
 * Warehouse accounts, managed from Settings.
 *
 * `requireUser` on every one of them, which is operator-only — so a warehouse
 * phone cannot create itself a second account or take over the office's. That
 * is not theoretical: a server action is a public endpoint whatever the page
 * around it looks like, and these take a user id out of a form. The id is
 * fenced to `role = 'scanner'` inside lib/scan/accounts.ts as well, which is
 * what stops a hand-crafted request pointing "set a new password" at the
 * operator's own account.
 *
 * Nothing here deletes an account. Disabling ends the worker's sessions at
 * once and keeps their scans attached to a name, which is what the Returns tab
 * and "last scan" read; deleting would either take the scans with it or leave
 * rows nobody can attribute.
 */

export interface AccountResult {
  ok: boolean;
  error?: string;
}

export async function addWorker(form: FormData): Promise<AccountResult> {
  await requireUser();

  const answer = await addScanner({
    name: String(form.get('name') ?? ''),
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
  });

  if (!answer.ok) return { ok: false, error: answer.error };

  // The name only, never the password. The ticker is on every panel screen,
  // and the repository this runs from is public.
  await say(`Scanner account added for ${String(form.get('name') ?? '').trim()}`);
  revalidatePath('/settings');
  return { ok: true };
}

export async function setWorkerActive(id: string, active: boolean): Promise<AccountResult> {
  await requireUser();

  const answer = await setScannerActive(id, active);
  if (!answer.ok) return { ok: false, error: answer.error };

  revalidatePath('/settings');
  return { ok: true };
}

export async function setWorkerPassword(id: string, password: string): Promise<AccountResult> {
  await requireUser();

  const answer = await setScannerPassword(id, password);
  if (!answer.ok) return { ok: false, error: answer.error };

  revalidatePath('/settings');
  return { ok: true };
}
