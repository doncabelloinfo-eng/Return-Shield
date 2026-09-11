import type { BuiltMessage, MessageProvider, SendResult } from '../types';

/**
 * Step 1. There is no provider.
 *
 * The engine still writes every message at exactly the moment it is due — it
 * just puts it in front of an operator to send from their own WhatsApp instead
 * of sending it itself. Turning on Step 2 changes which adapter is loaded and
 * nothing else, so the ladder that has been running for months keeps running.
 */
export class NoProvider implements MessageProvider {
  readonly name = 'none';
  readonly canSend = false;

  async send(): Promise<SendResult> {
    throw new Error(
      'messaging: Step 1 has no provider. Messages are queued for an operator '
      + 'to send; nothing should be calling send().',
    );
  }
}
