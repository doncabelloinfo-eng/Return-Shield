import { and, eq, isNull, lt, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import { alerts } from '@/db/schema';
import { now } from '@/lib/clock';
import { sendInternalAlert } from '@/lib/mail/send';

/**
 * Internal alerts, written down before they are sent.
 *
 * They used to go straight to the mailer, which had two problems. Two
 * concurrent job runs sent two emails for the same event, and an alert raised
 * while SMTP was unreachable disappeared — the one case where "we told
 * somebody" is the whole point.
 *
 * Now the alert is a row with a dedupe key. The second run's insert does
 * nothing, so only one email goes out; and the row survives whether or not the
 * mail did, so an alert that never left is something you can find rather than
 * something nobody knows about.
 */

export interface AlertSpec {
  /**
   * What this alert is ABOUT, as one stable string.
   *
   * It must be the same for two runs describing the same event, and different
   * for the same parcel's next genuinely-new event. Include the shipment and
   * what happened, not a timestamp: `return-started:<shipmentId>` is right,
   * `return-started:<shipmentId>:<now>` defeats the whole mechanism.
   */
  dedupeKey: string;
  subject: string;
  lines: string[];
  shipmentId?: string;
}

/**
 * Raise an alert, once.
 *
 * Returns whether this call was the one that raised it. The send happens only
 * for the winner, so a losing concurrent run neither emails nor reports that
 * it did.
 */
export async function raiseAlert(spec: AlertSpec): Promise<boolean> {
  const body = spec.lines.join('\n');

  const [row] = await getDb().insert(alerts).values({
    dedupeKey: spec.dedupeKey,
    subject: spec.subject,
    body,
    shipmentId: spec.shipmentId ?? null,
    createdAt: now(),
  }).onConflictDoNothing({ target: alerts.dedupeKey }).returning({ id: alerts.id });

  // No row means another run got there first. Nothing to do, and nothing to
  // report — it has already been said.
  if (!row) return false;

  await deliver(row.id, spec.subject, body);
  return true;
}

/**
 * Hand it to the mailer and record what happened.
 *
 * `logged` counts as delivered: with no SMTP host configured, stdout IS the
 * configured destination, and marking those rows as undelivered would make
 * every development machine look like a mail outage.
 */
async function deliver(id: string, subject: string, body: string): Promise<void> {
  try {
    const outcome = await sendInternalAlert({ subject, lines: body.split('\n') });
    await getDb().update(alerts).set({
      sentAt: outcome === 'failed' ? null : now(),
      error: outcome === 'failed' ? 'the mail server refused it' : null,
    }).where(eq(alerts.id, id));
  } catch (err) {
    // The row is already written, so the alert is not lost — just not delivered.
    const message = err instanceof Error ? err.message : String(err);
    await getDb().update(alerts).set({ error: message }).where(eq(alerts.id, id));
  }
}

/**
 * Alerts that were raised but never left. Shown nowhere yet; this is what a
 * future "something was not delivered" check would read, and in the meantime it
 * is what somebody debugging a missing email should look at.
 */
export async function undeliveredAlerts(limit = 20) {
  return getDb().select().from(alerts)
    .where(isNull(alerts.sentAt))
    .orderBy(desc(alerts.createdAt))
    .limit(limit);
}

/** Old delivered alerts are noise. The housekeeping job clears them. */
export async function purgeDeliveredAlerts(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(now().getTime() - olderThanDays * 86_400_000);
  const gone = await getDb().delete(alerts)
    .where(and(lt(alerts.createdAt, cutoff), isNull(alerts.error)))
    .returning({ id: alerts.id });
  return gone.length;
}
