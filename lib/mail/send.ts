import nodemailer, { type Transporter } from 'nodemailer';
import { envNumber, envOr } from '@/lib/env';

/**
 * Internal email: the daily digest and the alerts that cannot wait for
 * somebody to open the dashboard.
 *
 * With no SMTP host configured this logs instead of sending. That is the right
 * default for a fresh checkout — a half-configured mailer that throws would
 * take the escalation tick down with it, and a return alert is never worth
 * losing a tick over.
 */

let transport: Transporter | null | undefined;

function mailer(): Transporter | null {
  if (transport !== undefined) return transport;

  const host = process.env.SMTP_HOST;
  if (!host) { transport = null; return null; }

  transport = nodemailer.createTransport({
    host,
    port: envNumber('SMTP_PORT', 587),
    secure: envNumber('SMTP_PORT', 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  });
  return transport;
}

export interface Mail {
  subject: string;
  lines: string[];
  to?: string;
}

/**
 * `sent`   — it left the building.
 * `logged` — no SMTP is configured, so it went to stdout. That is the correct
 *            behaviour on a fresh checkout and on every dev machine, and it
 *            must NOT be treated as a failure: a daily job that threw because
 *            there is no mail server would fail all day, every day, locally.
 * `failed` — SMTP is configured and refused it. The caller should care.
 */
export type MailOutcome = 'sent' | 'logged' | 'failed';

export async function sendInternalAlert(mail: Mail): Promise<MailOutcome> {
  const to = mail.to ?? process.env.MAIL_TO;
  const body = mail.lines.join('\n');

  const t = mailer();
  if (!t || !to) {
    console.log(`[mail] ${mail.subject}\n${body}\n`);
    return 'logged';
  }

  try {
    await t.sendMail({
      from: envOr('MAIL_FROM', 'Return Shield <shield@localhost>'),
      to,
      subject: mail.subject,
      text: body,
    });
    return 'sent';
  } catch (err) {
    // Never let a mail failure stop the thing that triggered it — but do say
    // so, because a digest that records success on a morning when no email
    // left is a digest nobody gets and nobody misses.
    console.error('[mail] failed to send:', err instanceof Error ? err.message : err);
    return 'failed';
  }
}

export function resetMailer(): void { transport = undefined; }
