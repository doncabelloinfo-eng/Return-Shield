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
    const apiUrl = required('WHATSAPP_API_URL');
    const token = required('WHATSAPP_API_TOKEN');
    const phoneNumberId = required('WHATSAPP_PHONE_NUMBER_ID');
    cached = new WhatsAppCloudProvider(apiUrl, token, phoneNumberId);
    return cached;
  }

  throw new Error(`messaging: unknown WHATSAPP_PROVIDER "${kind}"`);
}

/** Tests swap the provider; nothing else should. */
export function setMessageProvider(p: MessageProvider | null): void {
  cached = p;
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`messaging: ${key} is required when WHATSAPP_PROVIDER is set`);
  return v;
}
