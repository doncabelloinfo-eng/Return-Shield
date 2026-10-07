-- The ship date, and the backfill for it.
--
-- SAFE TO RUN BEFORE DEPLOYING. One nullable column, one index, one relaxed
-- NOT NULL, and a backfill. Nothing already in production reads `shipped_at`,
-- and dropping a NOT NULL cannot break code that still writes a value — so the
-- running version carries on untouched either side of the deploy.
--
-- (The order matters the other way round, though. Migration first, Sync fork
-- second: when 0005 was deployed first, an escalation-tick read
-- `shipments.close_reason` before the column existed and failed.)

ALTER TABLE "orders" ALTER COLUMN "placed_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "shipments_shipped_idx" ON "shipments" USING btree ("shipped_at");--> statement-breakpoint
-- Backfill, using the same fallback chain the code uses when a source has no
-- ship date of its own: the Prerregistrado event, then the row's own
-- creation. Correct for everything we have today, because every existing
-- parcel arrived by webhook or by file without a fulfilment date — and the
-- 30-day Shopify pull overwrites these with the real fulfilment `created_at`
-- as it goes.
UPDATE "shipments" SET "shipped_at" = COALESCE(
  (SELECT min(e."occurred_at") FROM "shipment_events" e
    WHERE e."shipment_id" = "shipments"."id" AND e."event_code" = 'A090000V'),
  "created_at"
) WHERE "shipped_at" IS NULL;
