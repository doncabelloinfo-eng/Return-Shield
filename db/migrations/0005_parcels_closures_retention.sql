-- Parcels screen, closing by hand with a reason, and the 30-day window.
--
-- SAFE TO RUN BEFORE DEPLOYING. Every change here is additive: three nullable
-- columns on shipments, one new table, three new indexes. The code already in
-- production never reads any of them, and `dropped_at` is untouched, so it
-- remains the one answer to "is this parcel closed" for old and new code
-- alike.
--
-- `closures.shipment_id` is ON DELETE SET NULL on purpose, not CASCADE. The
-- rolling 30-day window deletes orders and cascades through shipments; this
-- table is the one record meant to outlive its parcel, so the FK must not take
-- it with the parcel.
--
-- The two indexes are what keep the new screen and the nightly cleanup off
-- sequential scans: `orders_created_idx` for "the order came in more than 30
-- days ago", `shipments_dropped_idx` for the Closed-by-hand tab.

CREATE TABLE "closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid,
	"order_number" text NOT NULL,
	"store_name" text NOT NULL,
	"shipping_code" text NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"value_cents" integer DEFAULT 0 NOT NULL,
	"days_since_order" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "close_note" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "closures_closed_idx" ON "closures" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX "closures_reason_idx" ON "closures" USING btree ("reason","closed_at");--> statement-breakpoint
CREATE INDEX "closures_shipment_idx" ON "closures" USING btree ("shipment_id");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "shipments_dropped_idx" ON "shipments" USING btree ("dropped_at");