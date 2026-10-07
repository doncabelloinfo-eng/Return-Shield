import type { BuiltMessage, MessageContext, MessageTemplate } from './types';


/**
 * Every word a customer reads, in one file.
 *
 * The wording is the prototype's, unchanged. The only difference is the date:
 * the prototype rendered "16 Sep" from an English month table, and these
 * messages are read by Spanish customers, so the month is Spanish here.
 * See DECISIONS.md — it is a one-line revert if that is not wanted.
 *
 * NO MESSAGE STATES A DATE CORREOS DID NOT GIVE US.
 *
 * Every one of these used to name a last day — "Último día para recogerlo: 16
 * sep", "el 16 sep tu pedido se devuelve automáticamente" — worked out from a
 * fifteen-day deposit window somebody typed into Settings and nobody had ever
 * confirmed with Correos. That is not a date to put in front of a customer: on
 * a service held longer it brings them in a week early in a panic, on a
 * shorter one it tells them they have time they do not have.
 *
 * What Correos does tell us is the day the parcel reached the counter. So the
 * messages say how long it has been waiting and that it will go back if it is
 * not collected, which is true, urgent and ours to say.
 */

const DEFAULT_LINK = 'Ver el estado de mi pedido';

export function buildMessage(template: MessageTemplate, ctx: MessageContext): BuiltMessage {
  const office = ctx.officeName ?? 'tu oficina de Correos';
  const days = ctx.daysAtOffice ?? 0;

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
          + 'Si no se recoge a tiempo, Correos lo devuelve.',
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
        body: `Tu pedido ${ctx.orderNumber} lleva ${days} días en ${office}. `
          + 'Recógelo pronto para que no vuelva a origen.',
        linkLabel: DEFAULT_LINK,
      };

    case 'office_last_call':
      return {
        template,
        body: `ÚLTIMO AVISO: tu pedido ${ctx.orderNumber} lleva ${days} días en ${office}. `
          + 'Si no se recoge, Correos lo devolverá y el pedido se cancelará.',
        linkLabel: 'Resolverlo ahora',
      };
  }
}

/**
 * The message the operator copies into WhatsApp. Everything the customer needs
 * to walk into the right building and come out with the parcel: which office,
 * where it is, when it is open if we actually know, and what to show at the
 * counter.
 *
 * What it no longer carries is a last day. See the note at the top of the file.
 */
export function officeDetails(ctx: MessageContext): string {
  const office = ctx.officeName ?? 'tu oficina de Correos';
  const address = ctx.officeAddress ? `, ${ctx.officeAddress}` : '';
  /*
   * The hours sentence is left out entirely when Correos has given us none.
   *
   * It used to fall back to a hard-coded `L–V 08:30–20:30 · S 09:30–13:00`,
   * and since today's events carry no office details at all, that meant every
   * customer was told opening times nobody had checked. A customer who turns
   * up to a closed door because of a line we invented is worse off than one
   * who looks the hours up.
   */
  const hours = ctx.officeHours?.trim()
    ? `Horario: ${ctx.officeHours.trim()}. `
    : '';

  /*
   * Two changes for the marketplace parcels, and only these two.
   *
   * The greeting drops the name when there is none. These files carry no
   * customer details, and the importer used to supply "Unknown customer", so
   * the message opened "Hola Unknown" — `firstName` takes the first word of
   * whatever is there.
   *
   * And `somos {store}` goes, because the message is pasted into Amazon's or
   * TikTok's own chat, which already shows the seller. "Somos Amazon ES" would
   * be us claiming to be the marketplace.
   */
  const greeting = ctx.firstName.trim() ? `Hola ${ctx.firstName.trim()}` : 'Hola';
  const who = ctx.viaMarketplace ? '' : `, somos ${ctx.storeName}`;

  return `${greeting}${who}. `
    + `Tu pedido ${ctx.orderNumber} te espera en ${office}${address}. `
    + hours
    + `Enseña este código: ${ctx.shippingCode}. `
    + 'Recógelo cuanto antes: si no se recoge a tiempo, Correos lo devuelve. '
    + 'Si no puedes ir, dínoslo y lo reenviamos.';
}

/**
 * The subject line of the email version, so the wording has one home like
 * every other word a customer reads.
 */
export function officeEmailSubject(orderNumber: string): string {
  return `Tu pedido ${orderNumber} te espera en Correos`;
}

/** A `mailto:` with the subject and the office text, both encoded. */
export function emailLink(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
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
