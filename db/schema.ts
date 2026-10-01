import { sql } from 'drizzle-orm';
import {
  pgTable, text, integer, bigint, boolean, timestamp, jsonb, uuid,
  uniqueIndex, index, primaryKey, doublePrecision, check,
} from 'drizzle-orm/pg-core';

/* ---------------------------------------------------------------------------
 * Money is stored in cents, as integers. Every sum, comparison and "most money
 * at risk first" ordering happens in the database, and floats lose cents.
 * The UI divides by 100 once, at the edge.
 * ------------------------------------------------------------------------- */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
})).enableRLS();

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  userIdx: index('sessions_user_idx').on(t.userId),
  expiryIdx: index('sessions_expiry_idx').on(t.expiresAt),
})).enableRLS();

export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The slug in /api/webhooks/shopify/{key} and the suffix of SHOPIFY_<KEY>_*.
  key: text('key').notNull(),
  name: text('name').notNull(),
  platform: text('platform').notNull().$type<'shopify' | 'tiktok'>(),
  ingest: text('ingest').notNull().$type<'auto' | 'manual'>(),
  shopDomain: text('shop_domain'),
  timezone: text('timezone').notNull().default('Europe/Madrid'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyIdx: uniqueIndex('stores_key_idx').on(t.key),
})).enableRLS();

export const offices = pgTable('offices', {
  id: uuid('id').primaryKey().defaultRandom(),
  correosCode: text('correos_code').notNull(),
  name: text('name').notNull(),
  address: text('address').notNull().default(''),
  postalCode: text('postal_code'),
  city: text('city'),
  openingHours: text('opening_hours'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('offices_correos_code_idx').on(t.correosCode),
})).enableRLS();

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id),
  externalOrderId: text('external_order_id').notNull(),
  orderNumber: text('order_number').notNull(),
  customerName: text('customer_name').notNull(),
  phoneE164: text('phone_e164'),
  phoneRaw: text('phone_raw'),
  // ok = a mobile we can message · landline = reachable by voice only ·
  // invalid = wrong shape · missing = nothing at all. Anything but `ok` means
  // the escalation ladder cannot message this customer, and the UI says so.
  phoneStatus: text('phone_status').notNull().default('missing')
    .$type<'ok' | 'landline' | 'invalid' | 'missing'>(),
  email: text('email'),
  addressLine: text('address_line'),
  city: text('city'),
  postalCode: text('postal_code'),
  province: text('province'),
  country: text('country').notNull().default('ES'),
  totalValueCents: integer('total_value_cents').notNull().default(0),
  currency: text('currency').notNull().default('EUR'),
  paymentMethod: text('payment_method').notNull().$type<'prepaid' | 'cod'>(),
  placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  // Set when a parcel of theirs has come back. Survives the order it came from.
  repeatRisk: boolean('repeat_risk').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  externalIdx: uniqueIndex('orders_store_external_idx').on(t.storeId, t.externalOrderId),
  postcodeIdx: index('orders_postcode_idx').on(t.postalCode),
  phoneIdx: index('orders_phone_idx').on(t.phoneE164),
})).enableRLS();

export const shipments = pgTable('shipments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  carrier: text('carrier').notNull().default('correos'),
  shippingCode: text('shipping_code').notNull(),
  productCode: text('product_code').notNull().default('PAQ ESTÁNDAR'),

  /* --- projection of shipment_events. Never edited by hand; rebuilt by
     lib/state-machine/project.ts so a normaliser fix can be replayed. --- */
  state: text('state').notNull().default('created'),
  stateSince: timestamp('state_since', { withTimezone: true }),
  officeId: uuid('office_id').references(() => offices.id),
  officeArrivedAt: timestamp('office_arrived_at', { withTimezone: true }),
  officeDeadline: timestamp('office_deadline', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),

  /* --- operator/engine state, not derived from events --- */
  escalationStage: text('escalation_stage'),
  mutedUntil: timestamp('muted_until', { withTimezone: true }),
  snoozeReason: text('snooze_reason'),
  // "Stop chasing this one" — survives every event, silences everything.
  droppedAt: timestamp('dropped_at', { withTimezone: true }),
  // Put back in stock once it physically came back.
  restockedAt: timestamp('restocked_at', { withTimezone: true }),
  // They asked for a different address and Correos has not been told yet.
  redirectPending: boolean('redirect_pending').notNull().default(false),
  // Did the customer ever answer a message or tap the action page?
  reacted: boolean('reacted').notNull().default(false),
  /**
   * When the reconcile sweep last asked Correos about this parcel.
   *
   * This is the sweep's cursor. Ordering by it, nulls first, means a run that
   * is cut short simply leaves the rest with an older stamp and the next run
   * picks them up — no offset to persist, nothing to get out of step when
   * parcels are added or finish, and no parcel can be starved because the one
   * checked longest ago is always next.
   */
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('shipments_shipping_code_idx').on(t.shippingCode),
  orderIdx: index('shipments_order_idx').on(t.orderId),
  stateIdx: index('shipments_state_idx').on(t.state),
  deadlineIdx: index('shipments_deadline_idx').on(t.officeDeadline),
  lastEventIdx: index('shipments_last_event_idx').on(t.lastEventAt),
  // The sweep's index: oldest-checked first, among the live ones.
  reconcileIdx: index('shipments_reconcile_idx').on(t.lastReconciledAt),
})).enableRLS();

/**
 * Append-only. The source of truth. Nothing here is ever updated or deleted;
 * the shipments row above is recomputed from these.
 *
 * The UNIQUE below is what lets the push receiver and the reconcile sweep both
 * write the same event without the ladder firing twice at a customer who has
 * already heard from us.
 */
export const shipmentEvents = pgTable('shipment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  rawPayload: jsonb('raw_payload').notNull(),
  eventCode: text('event_code').notNull(),
  // Correos' own Spanish words, kept exactly as they arrived and shown as-is.
  eventDesc: text('event_desc').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source').notNull().$type<'push' | 'poll' | 'system'>(),
  // null = Correos said something we have no mapping for. It is kept, shown in
  // the timeline, queued for review, and changes no state.
  mappedState: text('mapped_state'),
  officeCode: text('office_code'),
  officeName: text('office_name'),
}, (t) => ({
  dedupe: uniqueIndex('shipment_events_dedupe_idx').on(t.shipmentId, t.eventCode, t.occurredAt),
  shipmentIdx: index('shipment_events_shipment_idx').on(t.shipmentId, t.occurredAt),
  receivedIdx: index('shipment_events_received_idx').on(t.receivedAt),
})).enableRLS();

/**
 * Correos returns 200 and we process later, so the raw body lands here first.
 * If the normaliser is broken, nothing is lost — fix it and replay the rows.
 */
export const correosPushInbox = pgTable('correos_push_inbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  sourceIp: text('source_ip'),
}, (t) => ({
  pendingIdx: index('correos_push_inbox_pending_idx').on(t.processedAt, t.receivedAt),
})).enableRLS();

/** Codes Correos sent that we have no mapping for. Logged, never fatal. */
export const eventReviewQueue = pgTable('event_review_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventCode: text('event_code').notNull(),
  eventDesc: text('event_desc').notNull(),
  samplePayload: jsonb('sample_payload').notNull(),
  timesSeen: integer('times_seen').notNull().default(1),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedAs: text('resolved_as'),
}, (t) => ({
  codeIdx: uniqueIndex('event_review_queue_code_idx').on(t.eventCode, t.eventDesc),
})).enableRLS();

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  type: text('type').notNull()
    .$type<'call' | 'contact' | 'address_fix' | 'chase_carrier' | 'receive_return' | 'insight'>(),
  // Why this task exists, as a code the UI can switch on. The label is the
  // sentence an operator reads; the reason is what the code reasons about.
  reason: text('reason').notNull(),
  label: text('label').notNull(),
  priority: integer('priority').notNull().default(0),
  status: text('status').notNull().default('open').$type<'open' | 'done'>(),
  dueAt: timestamp('due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  outcome: text('outcome'),
  outcomeNote: text('outcome_note'),
  closedBy: uuid('closed_by').references(() => users.id),
}, (t) => ({
  // One open task of a given type per shipment. A second "call them" task is
  // not more information, it is the same job listed twice.
  openIdx: uniqueIndex('tasks_open_unique_idx').on(t.shipmentId, t.type)
    .where(sql`status = 'open'`),
  shipmentIdx: index('tasks_shipment_idx').on(t.shipmentId),
  statusIdx: index('tasks_status_idx').on(t.status),
})).enableRLS();

/** Every call logged, every customer tap, every thing an operator did. */
export const contactLog = pgTable('contact_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  outcome: text('outcome').notNull(),
  note: text('note').notNull().default(''),
  userId: uuid('user_id').references(() => users.id),
}, (t) => ({
  shipmentIdx: index('contact_log_shipment_idx').on(t.shipmentId, t.at),
})).enableRLS();

/**
 * A rung that must never fire again for this shipment — either because it
 * already fired, or because something silenced it (delivered, collected, the
 * customer answered). One table for both: the engine only ever asks
 * "may this rung still fire?".
 */
export const escalationFires = pgTable('escalation_fires', {
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  rungId: text('rung_id').notNull(),
  firedAt: timestamp('fired_at', { withTimezone: true }),
  silencedAt: timestamp('silenced_at', { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.shipmentId, t.rungId] }),
})).enableRLS();

/** Follow-ups the engine schedules for itself: re-check, retry, no-reply. */
export const escalationExtras = pgTable('escalation_extras', {
  id: uuid('id').primaryKey().defaultRandom(),
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  rungId: text('rung_id').notNull(),
  kind: text('kind').notNull().$type<'recheck' | 'retry' | 'nochk'>(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  rungIdx: uniqueIndex('escalation_extras_rung_idx').on(t.shipmentId, t.rungId),
  /**
   * The invariant scheduleExtra's own comment states: one of each kind in
   * flight per shipment. It was not enforced, and could not be by the index
   * above, because the rung id embeds the due timestamp — two runs a
   * millisecond apart produce two different ids and no conflict.
   */
  kindIdx: uniqueIndex('escalation_extras_kind_idx').on(t.shipmentId, t.kind),
  dueIdx: index('escalation_extras_due_idx').on(t.dueAt),
})).enableRLS();

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => stores.id),
  filename: text('filename').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  rowsTotal: integer('rows_total').notNull().default(0),
  rowsNew: integer('rows_new').notNull().default(0),
  rowsDuplicate: integer('rows_duplicate').notNull().default(0),
  rowsError: integer('rows_error').notNull().default(0),
  rowsAutofixed: integer('rows_autofixed').notNull().default(0),
  errorReport: jsonb('error_report').notNull().default([]),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index('import_batches_created_idx').on(t.createdAt),
})).enableRLS();

/**
 * How many days the post office holds a parcel, per Correos product code.
 * Never hardcode 15 — this table is the only place the number lives.
 */
export const productRules = pgTable('product_rules', {
  productCode: text('product_code').primaryKey(),
  depositDays: integer('deposit_days').notNull(),
  label: text('label').notNull().default(''),
  // False until somebody has actually confirmed the number with Correos.
  // The Settings screen says so out loud while this is false.
  confirmedWithCarrier: boolean('confirmed_with_carrier').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const postcodeStats = pgTable('postcode_stats', {
  postalCode: text('postal_code').primaryKey(),
  town: text('town'),
  shipped: integer('shipped').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  returned: integer('returned').notNull().default(0),
  failRate: doublePrecision('fail_rate').notNull().default(0),
  // Set by the nightly job when this area fails far more than average.
  watch: boolean('watch').notNull().default(false),
  rebuiltAt: timestamp('rebuilt_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  template: text('template').notNull(),
  body: text('body').notNull(),
  linkLabel: text('link_label'),
  channel: text('channel').notNull().default('whatsapp'),
  // queued  — written, waiting for the operator to send it (Step 1)
  // sent    — handed to the provider (Step 2)
  // failed  — the provider rejected it
  status: text('status').notNull().default('queued')
    .$type<'queued' | 'sent' | 'failed' | 'copied'>(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  actionToken: text('action_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  linkOpenedAt: timestamp('link_opened_at', { withTimezone: true }),

  /* --- what this message was, so a second writer cannot repeat it --------
   *
   * Several notifications per shipment are legitimate: one per rung, over a
   * fortnight. So the identity of a message is not the shipment — it is the
   * FIRING that produced it: which rung, and the moment that rung was due.
   *
   * `rung_due_at` is in the key and is load-bearing. A parcel can legitimately
   * go failed → out_for_delivery → failed, which is a second delivery attempt;
   * lib/shipments/ingest.ts clears every escalation_fires row when that
   * happens, so the first-contact message is correctly due again. Keying on
   * (shipment, rung) alone would make that second, correct message vanish with
   * no error and nothing in any log.
   *
   * Both columns are null for a message an operator wrote by hand, and the
   * CHECK below keeps them null together — a unique index treats nulls as
   * distinct, so one stray null would switch the whole guarantee off silently.
   */
  rungId: text('rung_id'),
  rungDueAt: timestamp('rung_due_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx: uniqueIndex('notifications_token_idx').on(t.actionToken),
  shipmentIdx: index('notifications_shipment_idx').on(t.shipmentId, t.createdAt),
  rungIdx: uniqueIndex('notifications_rung_idx').on(t.shipmentId, t.rungId, t.rungDueAt),
  rungPaired: check(
    'notifications_rung_paired',
    sql`(rung_id IS NULL) = (rung_due_at IS NULL)`,
  ),
})).enableRLS();

export const shipmentActions = pgTable('shipment_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  shipmentId: uuid('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  notificationId: uuid('notification_id').references(() => notifications.id),
  token: text('token').notNull(),
  action: text('action').notNull()
    .$type<'ok_address' | 'change_address' | 'cant_go' | 'call_me'>(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (t) => ({
  shipmentIdx: index('shipment_actions_shipment_idx').on(t.shipmentId),
})).enableRLS();

/** Per-IP rate limiting for the public action page. */
export const actionRateLimit = pgTable('action_rate_limit', {
  ip: text('ip').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  hits: integer('hits').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.ip, t.windowStart] }),
})).enableRLS();

/** "What the system just did" — the ticker across the top of every screen. */
export const activity = pgTable('activity', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  text: text('text').notNull(),
  shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'set null' }),
  kind: text('kind').notNull().default('system'),
  /**
   * Set when a line describes a thing that happened once, so two concurrent
   * runs cannot narrate it twice. Left null for anything genuinely repeatable
   * — an operator restocking the same parcel twice is two events, not one.
   */
  dedupeKey: text('dedupe_key'),
}, (t) => ({
  atIdx: index('activity_at_idx').on(t.at),
  dedupeIdx: uniqueIndex('activity_dedupe_idx').on(t.dedupeKey),
})).enableRLS();

/** Small key/value store: the demo clock offset, job watermarks, the phase. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * One row per scheduled job, holding a lease.
 *
 * Vercel Cron is best-effort: a run is never retried, the same run can fire
 * twice, and two runs can overlap. The usual answer — a session advisory lock —
 * is unavailable, because Supabase's transaction pooler multiplexes
 * connections and nothing session-scoped survives between statements.
 *
 * So the lock is a row with an expiry, taken and released with single
 * statements. See lib/job-lock.ts; the important part is that both the lease
 * and the comparison are computed by the DATABASE, never by lib/clock.ts —
 * demo mode can move the app clock by a fortnight, which would write a lease a
 * fortnight into the future and wedge the job until somebody edited the row.
 */
export const jobLocks = pgTable('job_locks', {
  /** A JobName. Not the route path: the two differ, and have differed. */
  job: text('job').primaryKey(),
  /** When the lease runs out. In the past means free. */
  lockedUntil: timestamp('locked_until', { withTimezone: true }).notNull(),
  /**
   * Who holds it. A fencing token: an instance that was frozen past its lease
   * and then woke up must not release a lock a later run legitimately holds —
   * that would re-create the exact double-run the lock exists to prevent.
   */
  lockedBy: text('locked_by'),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }),
}).enableRLS();

/**
 * Internal alerts, as an outbox rather than a side effect.
 *
 * "A return has started" used to go straight to the mailer, which meant two
 * concurrent runs sent two emails and a mailer outage lost the alert entirely.
 * A row with a dedupe key makes the second run a no-op and leaves the first
 * one's alert on the record whether or not SMTP was reachable.
 */
export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * What this alert is about, as one string. Two runs that compute the same
   * key are telling us the same thing; the second insert does nothing.
   */
  dedupeKey: text('dedupe_key').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Null until it actually left. A row with no sentAt is worth looking at. */
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
}, (t) => ({
  dedupeIdx: uniqueIndex('alerts_dedupe_idx').on(t.dedupeKey),
  createdIdx: index('alerts_created_idx').on(t.createdAt),
})).enableRLS();

/** One row per job run, so push-heartbeat can tell broken from quiet. */
export const jobRuns = pgTable('job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  job: text('job').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  /**
   * true — it finished. false — it threw. null — the instance was killed
   * mid-run and the catch block never executed, which is NOT success.
   */
  ok: boolean('ok'),
  /**
   * The run decided there was nothing for it to do: outside working hours,
   * push not configured, today's digest already sent, the lock held by
   * somebody else.
   *
   * A column rather than a convention, because the convention was already
   * wrong: `detail.skipped` is a string[] of unreachable stores on a
   * shopify-backfill run that did its full work, so anything sniffing that key
   * is wrong on arrival.
   */
  skipped: boolean('skipped').notNull().default(false),
  detail: jsonb('detail').notNull().default({}),
}, (t) => ({
  jobIdx: index('job_runs_job_idx').on(t.job, t.startedAt),
  /**
   * The engine-health banner reads the newest successful run on every page
   * load. Without this it is a sequential scan, and this table grows by about
   * five hundred rows a day.
   */
  startedIdx: index('job_runs_started_idx').on(t.startedAt),
  /**
   * For "when did this job last actually do something".
   *
   * Without it that probe degenerates exactly where it matters: a job with no
   * matching row — push-drain while push is off, reconcile before the Correos
   * credentials arrive — reads its entire history to return nothing.
   */
  realRunIdx: index('job_runs_real_idx').on(t.job, t.startedAt)
    .where(sql`ok IS TRUE AND skipped IS FALSE`),
})).enableRLS();
