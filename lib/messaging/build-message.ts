import type { BuiltMessage, MessageContext, MessageTemplate } from './types';
import { shortDateEs } from '@/lib/time';

/**
 * Every word a customer reads, in one file.
 *
 * The wording is the prototype's, unchanged. The only difference is the date:
 * the prototype rendered "16 Sep" from an English month table, and these
 * messages are read by Spanish customers, so the month is Spanish here.
 * See DECISIONS.md — it is a one-line revert if that is not wanted.
 */

const DEFAULT_LINK = 'Ver el estado de mi pedido';

/** The office hours line, until the real per-office hours are loaded. */
export const DEFAULT_OFFICE_HOURS = 'L–V 08:30–20:30 · S 09:30–13:00';

export function buildMessage(template: MessageTemplate, ctx: MessageContext): BuiltMessage {
  const deadline = ctx.deadline ? shortDateEs(ctx.deadline) : 'los próximos días';
  const office = ctx.officeName ?? 'tu oficina de Correos';

  switch (template) {
    case 'failed_first':
      return {
        template,
        body: `Hemos intentado entregar tu pedido ${ctx.orderNumber} y no había nadie. `
          + 'Dinos qué prefieres y lo resolvemos hoy.',
        linkLabel: DEFAULT_LINK,
      };

    case 'failed_reminder':
      return {
        template,
        body: `Tu pedido ${ctx.orderNumber} sigue pendiente. `
          + 'Confirma tu dirección o pide una nueva entrega.',
        linkLabel: DEFAULT_LINK,
      };

    case 'office_details':
      return {
        template,
        body: officeDetails(ctx),
        linkLabel: DEFAULT_LINK,
      };

    case 'office_reminder':
      return {
        template,
        body: `Recuerda: tu pedido sigue esperándote en ${office}. `
          + `Si no lo recoges antes del ${deadline} volverá a origen.`,
        linkLabel: DEFAULT_LINK,
      };

    case 'office_elsewhere':
      return {
        template,
        body: '¿No puedes pasar por la oficina? Podemos reenviarlo a otra dirección.',
        linkLabel: 'Elegir otra dirección',
      };

    case 'office_four_days':
      return {
        template,
        body: `Quedan 4 días: el ${deadline} tu pedido ${ctx.orderNumber} `
          + 'se devuelve automáticamente.',
        linkLabel: DEFAULT_LINK,
      };

    case 'office_last_call':
      return {
        template,
        body: `ÚLTIMO AVISO: quedan 2 días. El ${deadline} tu pedido se devuelve y se cancela.`,
        linkLabel: 'Resolverlo ahora',
      };
  }
}

/**
 * The message the operator copies into WhatsApp. Everything the customer needs
 * to walk into the right building and come out with the parcel: which office,
 * where it is, when it is open, what to show at the counter, and the real last
 * day — never a hardcoded fortnight.
 */
export function officeDetails(ctx: MessageContext): string {
  const deadline = ctx.deadline ? shortDateEs(ctx.deadline) : 'los próximos días';
  const office = ctx.officeName ?? 'tu oficina de Correos';
  const address = ctx.officeAddress ? `, ${ctx.officeAddress}` : '';
  const hours = ctx.officeHours ?? DEFAULT_OFFICE_HOURS;
  return `Hola ${ctx.firstName}, somos ${ctx.storeName}. `
    + `Tu pedido ${ctx.orderNumber} te espera en ${office}${address}. `
    + `Horario: ${hours}. `
    + `Enseña este código: ${ctx.shippingCode}. `
    + `Último día para recogerlo: ${deadline}. `
    + 'Si no puedes ir, dínoslo y lo reenviamos.';
}

/** The wa.me link behind "Open WhatsApp". Digits only, then the text. */
export function whatsappLink(phoneE164: string, body: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(body)}`;
}

/** The tel: link behind the big phone number on the call list. */
export function telLink(phoneE164: string): string {
  return `tel:${phoneE164.replace(/[^\d+]/g, '')}`;
}

/** "Open in maps" for an office. */
export function mapsLink(officeName: string | null, officeAddress: string | null): string {
  const q = [officeName, officeAddress].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
