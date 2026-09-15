ALTER TABLE "shipments" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "shipments_reconcile_idx" ON "shipments" USING btree ("last_reconciled_at");