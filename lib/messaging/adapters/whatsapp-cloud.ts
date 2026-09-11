import type { BuiltMessage, MessageProvider, SendResult } from '../types';

/**
 * Step 2. WhatsApp Cloud API.
 *
 * Templates carry a URL button and never a quick-reply button: the number is
 * send-only, so a quick reply would be a trap that lets a customer think they
 * had answered when nobody is listening. The template on the provider's side
 * must be registered with a URL button for this to go out at all.
 */
export class WhatsAppCloudProvider implements MessageProvider {
  readonly name = 'whatsapp-cloud';
  readonly canSend = true;

  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly phoneNumberId: string,
  ) {}

  async send(to: string, message: BuiltMessage, actionUrl: string | null): Promise<SendResult> {
    const url = `${this.apiUrl.replace(/\/$/, '')}/${this.phoneNumberId}/messages`;

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/[^\d]/g, ''),
      type: 'template',
      template: {
        name: message.template,
        language: { code: 'es' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: message.body }] },
          ...(actionUrl
            ? [{
                type: 'button',
                sub_type: 'url',
                index: '0',
                parameters: [{ type: 'text', text: actionUrl }],
              }]
            : []),
        ],
      },
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const json = (await res.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
        error?: { message?: string };
      };

      if (!res.ok) {
        return {
          providerMessageId: null,
          status: 'failed',
          error: json.error?.message ?? `provider returned ${res.status}`,
        };
      }

      return { providerMessageId: json.messages?.[0]?.id ?? null, status: 'sent' };
    } catch (err) {
      return {
        providerMessageId: null,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
