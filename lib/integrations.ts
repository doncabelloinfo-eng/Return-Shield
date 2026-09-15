import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { stores } from '@/db/schema';
import { storeEnv } from '@/lib/carriers/shopify/verify';

/**
 * What is wired up, and what is not.
 *
 * None of these credentials exist on day one, and the dashboard still has to
 * run — somebody has to be able to log in, look at seeded parcels and learn
 * the screens before Correos has been called. So a missing integration is a
 * notice on the Settings screen, never a crash.
 *
 * Each entry says what stops working, in terms of what the business loses,
 * rather than naming an environment variable and leaving it there.
 */

export type IntegrationStatus = 'ready' | 'missing' | 'partial';

export interface Integration {
  key: string;
  name: string;
  status: IntegrationStatus;
  /** What works, or what does not, in plain English. */
  detail: string;
  /** The variables still to set. Named so they can be pasted into Vercel. */
  missingVars: string[];
}

export async function integrationStatus(): Promise<Integration[]> {
  return [correosPush(), correosTrackpub(), await shopify(), whatsapp()];
}

function correosPush(): Integration {
  const missing = ['CORREOS_PUSH_CLIENT_ID', 'CORREOS_PUSH_CLIENT_SECRET']
    .filter((v) => !process.env[v]);

  if (missing.length) {
    return {
      key: 'correos-push',
      name: 'Correos live tracking',
      status: 'missing',
      detail: 'The receiver refuses every request until these are set, so no tracking '
        + 'arrives by itself. Parcels added by hand or by Shopify still appear, but their '
        + 'countdowns will not start until Correos can reach us.',
      missingVars: missing,
    };
  }

  const allowlisted = Boolean(process.env.CORREOS_PUSH_ALLOWED_IPS);
  return {
    key: 'correos-push',
    name: 'Correos live tracking',
    status: allowlisted ? 'ready' : 'partial',
    detail: allowlisted
      ? 'Correos can reach the receiver, and only from the addresses we expect.'
      : 'Correos can reach the receiver. No IP allowlist is set, so the client id and '
        + 'secret are the only thing standing between the shipment table and the internet '
        + '— set CORREOS_PUSH_ALLOWED_IPS once Correos tell you the address they call from.',
    missingVars: [],
  };
}

function correosTrackpub(): Integration {
  const missing = ['CORREOS_CLIENT_ID', 'CORREOS_CLIENT_SECRET', 'CORREOS_JWT']
    .filter((v) => !process.env[v]);

  return missing.length
    ? {
        key: 'correos-trackpub',
        name: 'Correos reconcile sweep',
        status: 'missing',
        detail: 'The two-hourly sweep does nothing. This is the only thing that repairs an '
          + 'update Correos dropped — they do not retry — so until it is set, a lost event '
          + 'means a countdown that is silently wrong.',
        missingVars: missing,
      }
    : {
        key: 'correos-trackpub',
        name: 'Correos reconcile sweep',
        status: 'ready',
        detail: 'Sweeping every two hours, oldest-checked first.',
        missingVars: [],
      };
}

async function shopify(): Promise<Integration> {
  const rows = await getDb().select({ key: stores.key, name: stores.name })
    .from(stores).where(eq(stores.platform, 'shopify'));

  if (!rows.length) {
    return {
      key: 'shopify',
      name: 'Shopify',
      status: 'missing',
      detail: 'No Shopify shops are set up yet, so no orders arrive on their own.',
      missingVars: [],
    };
  }

  const missingVars: string[] = [];
  const unconfigured: string[] = [];

  for (const store of rows) {
    const secret = storeEnv(store.key, 'WEBHOOK_SECRET');
    const token = storeEnv(store.key, 'ACCESS_TOKEN');
    if (!secret || !token) {
      unconfigured.push(store.name);
      const prefix = `SHOPIFY_${store.key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      if (!secret) missingVars.push(`${prefix}_WEBHOOK_SECRET`);
      if (!token) missingVars.push(`${prefix}_ACCESS_TOKEN`);
    }
  }

  if (!unconfigured.length) {
    return {
      key: 'shopify',
      name: 'Shopify',
      status: 'ready',
      detail: `${rows.length} ${rows.length === 1 ? 'shop' : 'shops'} sending fulfilments, `
        + 'with an hourly backfill for the webhooks that go missing.',
      missingVars: [],
    };
  }

  return {
    key: 'shopify',
    name: 'Shopify',
    status: unconfigured.length === rows.length ? 'missing' : 'partial',
    detail: `${unconfigured.join(', ')} ${unconfigured.length === 1 ? 'has' : 'have'} no `
      + 'credentials, so nothing from there arrives on its own. Webhooks without a secret '
      + 'are rejected, which is deliberate — an unverified webhook writes to the order table.',
    missingVars,
  };
}

function whatsapp(): Integration {
  const provider = (process.env.WHATSAPP_PROVIDER ?? 'none').toLowerCase();

  if (provider === 'none' || provider === '') {
    return {
      key: 'whatsapp',
      name: 'WhatsApp — Step 1',
      status: 'ready',
      detail: 'The system writes every message at the moment it is due and puts it in front '
        + 'of you to send. Nothing goes out on its own, which is what Step 1 means.',
      missingVars: [],
    };
  }

  const missing = ['WHATSAPP_API_URL', 'WHATSAPP_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']
    .filter((v) => !process.env[v]);

  return missing.length
    ? {
        key: 'whatsapp',
        name: 'WhatsApp — Step 2',
        status: 'missing',
        detail: `WHATSAPP_PROVIDER is set to "${provider}" but the credentials are not, so `
          + 'messages fall back to being written for you rather than sent.',
        missingVars: missing,
      }
    : {
        key: 'whatsapp',
        name: 'WhatsApp — Step 2',
        status: 'ready',
        detail: 'Messages go out on their own, and you are only called in when nobody replies.',
        missingVars: [],
      };
}
