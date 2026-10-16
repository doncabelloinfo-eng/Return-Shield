-- Scanner: the warehouse phone.
--
-- SAFE TO RUN BEFORE DEPLOYING, and it has to be run first. Everything here is
-- additive: one defaulted column, two new tables, one new index on an existing
-- table. Nothing the version live today reads or writes changes shape, so the
-- running app carries on untouched either side of the deploy.
--
-- (The order matters the other way round. Migration first, Sync fork second:
-- when 0005 was deployed first, an escalation-tick read
-- `shipments.close_reason` before the column existed and failed.)
--
-- `users.role` DEFAULTS TO 'operator', so every account that exists becomes an
-- operator with no backfill and no statement that has to be got right. A
-- scanner account can only be created by the Settings screen, afterwards.

ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK (role IN ('operator', 'scanner'));--> statement-breakpoint

CREATE TABLE "scan_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" text NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scan_batches_direction_valid" CHECK (direction IN ('outgoing', 'incoming'))
);--> statement-breakpoint
ALTER TABLE "scan_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code_as_read" text NOT NULL,
	"base" text NOT NULL,
	"parcel_no" text,
	"postal_code" text,
	"source" text NOT NULL,
	"read_ids" text[] NOT NULL,
	"times_read" integer DEFAULT 1 NOT NULL,
	"order_number" text,
	"store_name" text,
	CONSTRAINT "scans_source_valid" CHECK (source IN ('barcode', 'typed')),
	CONSTRAINT "scans_direction_valid" CHECK (direction IN ('outgoing', 'incoming'))
);--> statement-breakpoint
ALTER TABLE "scans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "scan_batches" ADD CONSTRAINT "scan_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_batch_id_scan_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."scan_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- One open batch per worker and direction. In the database rather than only in
-- the code that opens one: a phone with a weak signal retries, and two opens
-- racing would split a pile across two batches whose counts both look wrong.
CREATE UNIQUE INDEX "scan_batches_open_idx" ON "scan_batches" USING btree ("user_id","direction") WHERE finished_at IS NULL;--> statement-breakpoint
CREATE INDEX "scan_batches_started_idx" ON "scan_batches" USING btree ("started_at");--> statement-breakpoint

-- The same code twice in one batch is one parcel read twice, never two rows.
CREATE UNIQUE INDEX "scans_batch_code_idx" ON "scans" USING btree ("batch_id","code_as_read");--> statement-breakpoint
CREATE INDEX "scans_base_idx" ON "scans" USING btree ("base","direction","scanned_at");--> statement-breakpoint
CREATE INDEX "scans_direction_time_idx" ON "scans" USING btree ("direction","scanned_at");--> statement-breakpoint
CREATE INDEX "scans_user_time_idx" ON "scans" USING btree ("user_id","scanned_at");--> statement-breakpoint
CREATE INDEX "scans_batch_time_idx" ON "scans" USING btree ("batch_id","scanned_at");--> statement-breakpoint

-- A scan is matched to a parcel on the first fifteen characters of the code —
-- the one part the Código de Bulto and the EXPEDICIÓN have in common. The
-- unique index on the whole code cannot serve that comparison, and it runs
-- once per parcel scanned.
CREATE INDEX "shipments_code_base_idx" ON "shipments" USING btree (left("shipping_code", 15));
