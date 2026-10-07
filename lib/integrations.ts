import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { stores } from '@/db/schema';
import { storeEnv } from '@/lib/carriers/shopify/verify';
import { env, envOr, envSet } from '@/lib/env';

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

/**
 * The rows the Connections panel shows.
 *
 * ONLY THINGS THAT ARE ACTUALLY CONNECTED, OR THAT SOMEBODY IS IN THE MIDDLE
 * OF CONNECTING.
 *
 * Two rows used to sit here permanently saying nothing was set up, and both
 * are now absent until there is something to say:
 *
 *   "Correos live push · Not set up" — push is not in use on purpose, the
 *   receiver refuses every request while its credentials are unset, and the
 *   two jobs that served it have been taken off the schedule. A row listing
 *   two variables for a feature nobody is turning on is noise on the one
 *   screen whose job is to show what works.
 *
 *   "WhatsApp — Step 1 · Connected" — there is no WhatsApp connection. The
 *   system writes the messages and a person sends them from their own phone,
 *   which is a workflow rather than an integration, and calling it Connected
 *   made the opposite claim.
 *
 * Both come back the moment their credentials exist, which is exactly when
 * their status becomes information.
 */
export async function integrationStatus(): Promise<Integration[]> {
  const { getSetting } = await import('@/lib/settings');
  const batchMode = await getSetting('correosBatchMode');

  const rows: (Integration | null)[] = [
    correosTrackpub(batchMode),
    correosPush(),
    await shopify(),
    email(),
    whatsapp(),
  ];

  return rows.filter((r): r is Integration => r !== null);
}

/** Null until somebody sets the push credentials. See the note above. */
function correosPush(): Integration | null {
  const missing = ['CORREOS_PUSH_CLIENT_ID', 'CORREOS_PUSH_CLIENT_SECRET'].filter((v) => !envSet(v));
  if (missing.length) return null;

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
  ].filter((v) => !envSet(v));

  const manualToken = envSet('CORREOS_JWT');

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

/**
 * Internal email: the return alerts and the daily digest.
 *
 * This row is here because of a failure that looks like success. With no SMTP
 * host configured, `sendInternalAlert` logs to stdout and returns `logged`,
 * and `logged` counts as delivered — deliberately, because a daily job that
 * threw for want of a mail server would fail every day on every dev machine.
 * The cost is that an alert nobody will ever read is stored as sent, and until
 * now nothing on any screen said whether a single email had ever left.
 */
function email(): Integration {
  const missing = ['SMTP_HOST', 'MAIL_TO'].filter((v) => !envSet(v));

  if (missing.length) {
    return {
      key: 'email',
      name: 'Email',
      status: 'missing',
      detail: 'Alerts and the daily digest only go to the logs. They are still raised and '
        + 'still recorded — the Today screen and the ticker show everything they would have '
        + 'said — but nothing arrives in an inbox, so nobody finds out about a parcel coming '
        + 'back unless they open the dashboard.',
      missingVars: missing,
    };
  }

  return {
    key: 'email',
    name: 'Email',
    status: 'ready',
    detail: `Alerts and the daily digest go to ${envOr('MAIL_TO', '')}.`,
    missingVars: [],
  };
}

/**
 * Null while no provider is configured — which is the case today, and means
 * the operator sends the messages themselves. See the note at the top.
 */
function whatsapp(): Integration | null {
  const provider = envOr('WHATSAPP_PROVIDER', 'none').toLowerCase();
  if (provider === 'none' || provider === '') return null;

  const missing = ['WHATSAPP_API_URL', 'WHATSAPP_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']
    .filter((v) => !envSet(v));

  return missing.length
    ? {
        key: 'whatsapp',
        name: 'WhatsApp sending',
        status: 'missing',
        detail: `WHATSAPP_PROVIDER is set to "${provider}" but the credentials are not, so `
          + 'messages are still written for you to send rather than sent automatically.',
        missingVars: missing,
      }
    : {
        key: 'whatsapp',
        name: 'WhatsApp sending',
        status: 'ready',
        detail: 'Messages go out on their own, and you are only called in when nobody replies.',
        missingVars: [],
      };
}
