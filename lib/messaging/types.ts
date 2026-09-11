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
  officeHours: string | null;
  /** The real last day, already worked out from product_rules. */
  deadline: Date | null;
  /** The customer's own page for this parcel, or null in Step 1. */
  actionUrl: string | null;
}

/** Every rung that speaks to a customer. The id is the rung's id. */
export type MessageTemplate =
  | 'failed_first'      // f15  — 15 minutes after a failed delivery
  | 'failed_reminder'   // f4h  — four hours later
  | 'office_details'    // o15  — where it is, when it closes, what to show
  | 'office_reminder'   // o12  — still waiting
  | 'office_elsewhere'  // o8   — we can send it somewhere else
  | 'office_four_days'  // o4   — four days left
  | 'office_last_call'; // o2   — last warning

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
 * Step 1 is the `none` adapter: nothing is sent, the operator copies the text
 * the templates produced. Step 2 swaps in a real provider and the exact same
 * text goes out on its own. Nothing above this interface changes.
 */
export interface MessageProvider {
  readonly name: string;
  /** False in Step 1. The engine queues the message for a human instead. */
  readonly canSend: boolean;
  send(to: string, message: BuiltMessage, actionUrl: string | null): Promise<SendResult>;
}
