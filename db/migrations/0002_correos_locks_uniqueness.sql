CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"shipment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_locks" (
	"job" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"locked_by" text,
	"acquired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "action_rate_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correos_push_inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "escalation_extras" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "escalation_fires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_review_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "postcode_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipment_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "rung_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "rung_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_idx" ON "alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_dedupe_idx" ON "activity" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_extras_kind_idx" ON "escalation_extras" USING btree ("shipment_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_rung_idx" ON "notifications" USING btree ("shipment_id","rung_id","rung_due_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_rung_paired" CHECK ((rung_id IS NULL) = (rung_due_at IS NULL));