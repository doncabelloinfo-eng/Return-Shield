import type { BuiltMessage, MessageProvider, SendResult } from '../types';

/**
 * No provider. The one in use today.
 *
 * The engine still writes every message at exactly the moment it is due — it
 * just puts it in front of an operator to send from their own WhatsApp instead
 * of sending it itself. Connecting a provider changes which adapter is loaded and
 * nothing else, so the ladder that has been running for months keeps running.
 */
export class NoProvider implements MessageProvider {
  readonly name = 'none';
  readonly canSend = false;

  async send(): Promise<SendResult> {
    throw new Error(
      'messaging: no provider is configured. Messages are queued for an operator '
      + 'to send; nothing should be calling send().',
    );
  }
}
