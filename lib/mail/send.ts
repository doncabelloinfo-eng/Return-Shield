import nodemailer, { type Transporter } from 'nodemailer';

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
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
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

export async function sendInternalAlert(mail: Mail): Promise<void> {
  const to = mail.to ?? process.env.MAIL_TO;
  const body = mail.lines.join('\n');

  const t = mailer();
  if (!t || !to) {
    console.log(`[mail] ${mail.subject}\n${body}\n`);
    return;
  }

  try {
    await t.sendMail({
      from: process.env.MAIL_FROM ?? 'Return Shield <shield@localhost>',
      to,
      subject: mail.subject,
      text: body,
    });
  } catch (err) {
    // Never let a mail failure stop the thing that triggered it.
    console.error('[mail] failed to send:', err instanceof Error ? err.message : err);
  }
}

export function resetMailer(): void { transport = undefined; }
