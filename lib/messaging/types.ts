/**
 * Everything `buildMessage` needs, and nothing it doesn't. Deliberately a flat
 * value object rather than a database row: the templates are then trivially
 * testable, and a change to the schema cannot silently change what a customer
 * reads.
 */
export interface MessageContext {
  firstName: string;
  storeName: string;
  orderNumber: string;
  shippingCode: string;
  officeName: string | null;
  officeAddress: string | null;
  /**
   * The office's real opening hours, or null when Correos has not told us any.
   *
   * Null means the "Horario: …" sentence is left out altogether. It used to
   * fall back to a hard-coded `L–V 08:30–20:30 · S 09:30–13:00`, and because
   * Correos' events carry no office details at all today, every customer was
   * being given opening times nobody had checked.
   */
  officeHours: string | null;
  /** When Correos said it was at the counter. The one date they do give us. */
  officeArrivedAt: Date | null;
  /** How long it has been there, in Madrid days. Null when it is not there. */
  daysAtOffice: number | null;
  /** The customer's own page, or null when a person sends the message. */
  actionUrl: string | null;
  /**
   * The message will be pasted into Amazon's or TikTok's own chat rather than
   * sent from us. The marketplace already shows the seller, so "somos
   * {storeName}" is left out — saying "somos Amazon ES" would be claiming to
   * be the marketplace.
   */
  viaMarketplace?: boolean;
}

/** Every rung that speaks to a customer. The id is the rung's id. */
export type MessageTemplate =
  | 'failed_first'      // f15  — 15 minutes after a failed delivery
  | 'failed_reminder'   // f4h  — four hours later
  | 'office_details'    // o15  — where it is, when it closes, what to show
  | 'office_reminder'   // o12  — still waiting
  | 'office_elsewhere'  // o8   — we can send it somewhere else
  | 'office_four_days'  // o4   — it has been there a while
  | 'office_last_call'; // o2   — last reminder

export interface BuiltMessage {
  template: MessageTemplate;
  /** The finished Spanish text. What gets copied, or sent. */
  body: string;
  /**
   * A link button, never a quick reply. The number cannot receive replies, so
   * a reply button would let a customer think they had acted when nobody is
   * listening. Every template that offers an action offers a link.
   */
  linkLabel: string;
}

export interface SendResult {
  providerMessageId: string | null;
  status: 'sent' | 'failed';
  error?: string;
}

/**
 * The only thing the rest of the codebase knows about WhatsApp.
 *
 * The `none` adapter is the one in use: nothing is sent, the operator copies
 * the text the templates produced. Connecting a real provider swaps it out and
 * the exact same text goes out on its own. Nothing above this interface
 * changes.
 */
export interface MessageProvider {
  readonly name: string;
  /** False with no provider connected. The engine queues it for a human. */
  readonly canSend: boolean;
  send(to: string, message: BuiltMessage, actionUrl: string | null): Promise<SendResult>;
}
