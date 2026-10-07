import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { notifications, tasks } from '@/db/schema';
import { TestClock, resetClock } from '@/lib/clock';
import { ingestEvent } from '@/lib/shipments/ingest';
import { runShipment } from '@/lib/escalation/run';
import { setSetting } from '@/lib/settings';
import { setMessageProvider, messageProvider } from '@/lib/messaging';
import { integrationStatus } from '@/lib/integrations';
import { nextAction, type DecidableShipment } from '@/lib/escalation/decide';
import { resetDb, closeDb } from './helpers/db';
import { makeShipment } from './helpers/fixtures';

/**
 * Nothing on the screen pretends.
 *
 * The operator has to be able to see exactly how far the system really goes,
 * and a control that does nothing in today's set-up makes that impossible. On
 * 7 October the Step 1 / Step 2 switch in the top bar was flipped back and
 * forth several times and nothing changed, because Step 2 also needs a
 * WhatsApp provider that can send and `WHATSAPP_PROVIDER` is `none`.
 *
 * So the switch is gone, two Connections rows that only ever said "not set up"
 * are gone, the two push jobs are off the schedule, and the restock buttons
 * say "Mark as" rather than claiming to move Shopify's stock. Every code path
 * behind them is intact; this file is what stops one of them coming back on
 * screen before it works.
 */

/** A file with its comments taken out — the notes explain what was removed. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

let clock: InstanceType<typeof TestClock>;

beforeEach(async () => {
  await resetDb();
  clock = new TestClock('2026-10-07T10:00:00+02:00');
  clock.install();
  setMessageProvider(null);
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.CORREOS_PUSH_CLIENT_ID;
  delete process.env.CORREOS_PUSH_CLIENT_SECRET;
  delete process.env.SMTP_HOST;
  delete process.env.MAIL_TO;
});

afterAll(async () => {
  resetClock();
  setMessageProvider(null);
  await closeDb();
});

describe('the top bar', () => {
  it('has no Step switch', () => {
    const src = codeOf('components/TopBar.tsx');
    expect(src).not.toContain('setPhase');
    expect(src).not.toContain('Step 1');
    expect(src).not.toContain('Step 2');
    // And no prop for it either, so the layout cannot pass one by accident.
    expect(src).not.toContain('phase');
  });

  it('has no action behind it any more', () => {
    expect(codeOf('app/actions/settings.ts')).not.toContain('export async function setPhase');
  });

  it('says nothing about steps anywhere the operator reads', () => {
    for (const file of [
      'components/TopBar.tsx',
      'components/Tabs.tsx',
      'components/DockTabs.tsx',
      'lib/integrations.ts',
      'lib/escalation/run.ts',
      'lib/escalation/ladder.ts',
    ]) {
      const src = codeOf(file);
      expect(src, file).not.toMatch(/Step [12]/);
    }
  });
});

describe('the escalation tick', () => {
  it('writes the message for a person whatever the stored phase says', async () => {
    const f = await makeShipment();
    // The switch is gone but the number is still in the table, and an old
    // database has it set to 2. The provider is what decides.
    await setSetting('phase', 2);
    expect(messageProvider().canSend).toBe(false);

    await ingestEvent({
      shippingCode: f.shippingCode,
      eventCode: 'H01I350V',
      eventDesc: 'A disposición del destinatario',
      occurredAt: clock.now(),
      source: 'poll',
      officeCode: f.officeCode,
      rawPayload: {},
    });
    await runShipment(f.shipmentId, clock.now());

    const [msg] = await getDb().select().from(notifications)
      .where(eq(notifications.shipmentId, f.shipmentId));
    expect(msg.status).toBe('queued');
    expect(msg.sentAt).toBeNull();

    // And a job for a person to do it, which is the honest outcome.
    const open = await getDb().select().from(tasks).where(eq(tasks.shipmentId, f.shipmentId));
    expect(open.some((t) => t.type === 'contact')).toBe(true);
  });

  it('keeps the code path for a provider that can send', () => {
    // Not removed, only unreachable today. This is the line that brings it
    // back, and it is still there.
    expect(codeOf('lib/escalation/run.ts')).toContain("settings.phase === 2 && provider.canSend");
  });
});

describe('Connections', () => {
  it('has no WhatsApp row while no provider is configured', async () => {
    const rows = await integrationStatus();
    expect(rows.map((r) => r.key)).not.toContain('whatsapp');
  });

  it('shows a WhatsApp row the moment somebody starts configuring one', async () => {
    process.env.WHATSAPP_PROVIDER = 'whatsapp-cloud';
    try {
      const rows = await integrationStatus();
      const wa = rows.find((r) => r.key === 'whatsapp');
      expect(wa?.name).toBe('WhatsApp sending');
      expect(wa?.status).toBe('missing');
      expect(wa?.missingVars).toContain('WHATSAPP_API_TOKEN');
    } finally {
      delete process.env.WHATSAPP_PROVIDER;
    }
  });

  it('has no Correos live push row while push is not configured', async () => {
    const rows = await integrationStatus();
    expect(rows.map((r) => r.key)).not.toContain('correos-push');
  });

  it('shows the push row again once its credentials exist', async () => {
    process.env.CORREOS_PUSH_CLIENT_ID = 'id';
    process.env.CORREOS_PUSH_CLIENT_SECRET = 'secret';
    try {
      const rows = await integrationStatus();
      expect(rows.map((r) => r.key)).toContain('correos-push');
    } finally {
      delete process.env.CORREOS_PUSH_CLIENT_ID;
      delete process.env.CORREOS_PUSH_CLIENT_SECRET;
    }
  });

  it('has an Email row that says Not set up without SMTP', async () => {
    const rows = await integrationStatus();
    const mail = rows.find((r) => r.key === 'email');

    expect(mail).toBeDefined();
    expect(mail!.name).toBe('Email');
    expect(mail!.status).toBe('missing');
    // The failure this row exists for: `logged` counts as delivered, so an
    // alert nobody will ever read is stored as sent and nothing said so.
    expect(mail!.detail).toContain('only go to the logs');
    expect(mail!.missingVars).toEqual(['SMTP_HOST', 'MAIL_TO']);
  });

  it('says Connected once SMTP is really configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.MAIL_TO = 'ops@example.com';
    try {
      const mail = (await integrationStatus()).find((r) => r.key === 'email');
      expect(mail!.status).toBe('ready');
      expect(mail!.detail).toContain('ops@example.com');
    } finally {
      delete process.env.SMTP_HOST;
      delete process.env.MAIL_TO;
    }
  });

  it('is partly set up when SMTP_HOST is there and nobody is listed', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    try {
      const mail = (await integrationStatus()).find((r) => r.key === 'email');
      expect(mail!.status).toBe('missing');
      expect(mail!.missingVars).toEqual(['MAIL_TO']);
    } finally {
      delete process.env.SMTP_HOST;
    }
  });
});

describe('the push jobs', () => {
  it('are off the schedule but still exist', async () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: { path: string }[];
    };
    const paths = config.crons.map((c) => c.path);
    expect(paths).not.toContain('/api/cron/push-drain');
    expect(paths).not.toContain('/api/cron/push-heartbeat');

    // Receiver and routes untouched: hitting one by hand still works.
    const drain = await import('@/app/api/cron/push-drain/route');
    expect(typeof drain.GET).toBe('function');
    const receiver = await import('@/app/api/webhooks/correos/track/route');
    expect(typeof receiver.POST).toBe('function');
  });

  it('are off the Scheduled jobs list', async () => {
    const { jobHealth } = await import('@/lib/engine-health');
    const jobs = (await jobHealth()).map((j) => j.job as string);
    expect(jobs).not.toContain('push-drain');
    expect(jobs).not.toContain('push-heartbeat');
  });
});

describe('the restock buttons', () => {
  const coming: DecidableShipment = {
    id: 'x',
    state: 'returning',
    officeArrivedAt: null,
    officeName: 'Oficina Madrid Sucursal 12',
    town: 'Getafe, Madrid',
    customerName: 'Lucía Fernández Ortiz',
    valueCents: 6490,
    paymentMethod: 'cod',
    dropped: false,
    restocked: false,
    redirectPending: false,
    mutedUntil: null,
    openTasks: [],
    lastContactOutcome: null,
  };

  it('say "Mark as back in stock", not "Put back in stock"', () => {
    // All either one does is record the restock here. Shopify's inventory does
    // not move, because the access token is `read_orders` only.
    expect(nextAction(coming)!.label).toBe('Mark as back in stock');
    expect(codeOf('components/RestockAll.tsx')).toContain('Mark as back in stock');
    expect(codeOf('components/RestockAll.tsx')).not.toContain('Put all back in stock');
  });

  it('are still there — the record is what clears the parcel', () => {
    expect(nextAction(coming)!.kind).toBe('restock');
  });
});

describe('the Correos buttons that only record', () => {
  it('say "Mark", because nothing here talks to Correos', () => {
    const base: DecidableShipment = {
      id: 'x',
      state: 'at_office',
      officeArrivedAt: null,
      officeName: null,
      town: '',
      customerName: 'Lucía',
      valueCents: 1000,
      paymentMethod: 'prepaid',
      dropped: false,
      restocked: false,
      redirectPending: true,
      mutedUntil: null,
      openTasks: [],
      lastContactOutcome: null,
    };

    // A redirection is arranged by a person, through Mi Oficina or on the
    // phone, and Correos charges for it. The button recorded that and said
    // "Send new address to Correos", with "Tap again — Correos charges" on the
    // confirm: together, that the press itself would arrange and pay for it.
    expect(nextAction(base)!.label).toBe('Mark new address as sent');
    expect(nextAction(base)!.needsConfirm).toBe(true);

    const chasing = {
      ...base,
      redirectPending: false,
      openTasks: [{ type: 'chase_carrier' as const, reason: 'no_updates', label: 'No update for 3 days' }],
    };
    expect(nextAction(chasing)!.label).toBe('Mark as asked Correos');

    const panel = codeOf('components/DangerActions.tsx');
    expect(panel).not.toContain('Send to a new address');
    expect(panel).not.toContain('Correos charges');
  });
});
