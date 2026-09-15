import type { MessageProvider } from './types';
import { NoProvider } from './adapters/none';
import { WhatsAppCloudProvider } from './adapters/whatsapp-cloud';

export * from './types';
export * from './build-message';

let cached: MessageProvider | null = null;

/**
 * Which step we are on is an environment variable, not a code change.
 * Nothing outside this file knows which adapter it got.
 */
export function messageProvider(): MessageProvider {
  if (cached) return cached;

  const kind = (process.env.WHATSAPP_PROVIDER ?? 'none').trim().toLowerCase();

  if (kind === 'none' || kind === '') {
    cached = new NoProvider();
    return cached;
  }

  if (kind === 'whatsapp-cloud') {
    const apiUrl = process.env.WHATSAPP_API_URL;
    const token = process.env.WHATSAPP_API_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!apiUrl || !token || !phoneNumberId) {
      // Half-configured is not a reason to take the escalation engine down.
      // Falling back to Step 1 means every message is still written at exactly
      // the right moment and put in front of an operator — the parcels keep
      // being chased, by hand, until somebody sets the rest of the variables.
      // The Settings screen says so in as many words.
      warnOnce(
        'WHATSAPP_PROVIDER is "whatsapp-cloud" but WHATSAPP_API_URL / _TOKEN / '
        + '_PHONE_NUMBER_ID are not all set. Messages will be written for an operator '
        + 'to send rather than sent automatically.',
      );
      cached = new NoProvider();
      return cached;
    }

    cached = new WhatsAppCloudProvider(apiUrl, token, phoneNumberId);
    return cached;
  }

  // An unrecognised provider is a typo in an environment variable. Falling back
  // to writing messages by hand is wrong in a small way; refusing to escalate
  // anything at all is wrong in a large one.
  warnOnce(`Unknown WHATSAPP_PROVIDER "${kind}" — falling back to Step 1.`);
  cached = new NoProvider();
  return cached;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[messaging] ${message}`);
}

/** Tests swap the provider; nothing else should. */
export function setMessageProvider(p: MessageProvider | null): void {
  cached = p;
  warned.clear();
}
