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
  const { getSetting } = await import('@/lib/settings');
  const batchMode = await getSetting('correosBatchMode');
  return [correosTrackpub(batchMode), correosPush(), await shopify(), whatsapp()];
}

function correosPush(): Integration {
  const missing = ['CORREOS_PUSH_CLIENT_ID', 'CORREOS_PUSH_CLIENT_SECRET']
    .filter((v) => !process.env[v]);

  if (missing.length) {
    return {
      key: 'correos-push',
      name: 'Correos live push',
      status: 'missing',
      detail: 'Not in use, on purpose: tracking runs on the three-hourly sweep above. '
        + 'The receiver refuses every request while these are unset, and the two jobs that '
        + 'serve push return immediately rather than reporting on something nobody switched '
        + 'on. Set these to get updates the moment Correos scans a parcel instead of within '
        + 'three hours.',
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

function correosTrackpub(batchMode: string): Integration {
  /**
   * Four variables, from two different places, and it is easy to set two of
   * them and think you are done:
   *
   *   CORREOS_CLIENT_ID / _SECRET        the API gateway credentials, from the
   *                                      developer-portal app
   *   CORREOS_OAUTH_CLIENT_ID / _SECRET  the CorreosID system-user application,
   *                                      exchanged for the bearer token
   *
   * CORREOS_JWT is deliberately NOT in this list. It is a token pasted in by
   * hand for testing; a thirty-minute credential is not something you configure
   * a deployment with, and requiring it here used to tell a correctly
   * configured deployment that its sweep did nothing.
   */
  const missing = [
    'CORREOS_CLIENT_ID',
    'CORREOS_CLIENT_SECRET',
    'CORREOS_OAUTH_CLIENT_ID',
    'CORREOS_OAUTH_CLIENT_SECRET',
  ].filter((v) => !process.env[v]);

  const manualToken = Boolean(process.env.CORREOS_JWT);

  if (missing.length) {
    // A hand-pasted token makes the sweep work without the OAuth pair, which is
    // useful for a first test and is not a configuration to leave in place.
    const workingAnyway = manualToken
      && !missing.includes('CORREOS_CLIENT_ID')
      && !missing.includes('CORREOS_CLIENT_SECRET');

    return {
      key: 'correos-trackpub',
      name: 'Correos tracking',
      status: workingAnyway ? 'partial' : 'missing',
      detail: workingAnyway
        ? 'Running on a token pasted in by hand, which expires in about half an hour and '
          + 'cannot be renewed. Fine for a test; set the OAuth pair before relying on it.'
        : 'The sweep does nothing, so no tracking reaches the system at all. Push is not '
          + 'configured either, so this is the only source of events — until it is set, '
          + 'every countdown on every screen is frozen at whatever it last knew.',
      missingVars: missing,
    };
  }

  const mode = batchMode === 'comma'
    ? 'Asking about a hundred parcels per request.'
    : batchMode === 'single'
      ? 'Correos would not take a batch, so it is asking one parcel per request — slower, '
        + 'and worth re-testing with the button above if that was a one-off.'
      : 'It has not needed a batch yet, so the multi-parcel format is still untested.';

  return {
    key: 'correos-trackpub',
    name: 'Correos tracking',
    status: 'ready',
    detail: `Sweeping every three hours, urgent parcels first. ${mode}`,
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
