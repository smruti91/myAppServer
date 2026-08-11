CREATE TABLE "employee_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"site_name" varchar(200) NOT NULL,
	"site_code" varchar(50),
	"address" text,
	"latitude" numeric(10, 7) NOT NULL,
	"longitude" numeric(10, 7) NOT NULL,
	"allowed_radius_meters" numeric(8, 2) DEFAULT '100' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_lat_range" CHECK ("sites"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "sites_lng_range" CHECK ("sites"."longitude" BETWEEN -180 AND 180),
	CONSTRAINT "sites_radius_positive" CHECK ("sites"."allowed_radius_meters" > 0)
);
--> statement-breakpoint
ALTER TABLE "client_locations" ALTER COLUMN "latitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "client_locations" ALTER COLUMN "longitude" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "client_locations" ALTER COLUMN "allowed_radius_meters" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD COLUMN "site_id" uuid;--> statement-breakpoint
ALTER TABLE "client_locations" ADD COLUMN "city" varchar(120);--> statement-breakpoint
ALTER TABLE "client_locations" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "client_locations" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_sites" ADD CONSTRAINT "employee_sites_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_sites" ADD CONSTRAINT "employee_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_location_id_client_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."client_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_sites_pair_idx" ON "employee_sites" USING btree ("employee_id","site_id");--> statement-breakpoint
CREATE INDEX "employee_sites_site_idx" ON "employee_sites" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_location_name_idx" ON "sites" USING btree ("location_id","site_name");--> statement-breakpoint
CREATE INDEX "sites_location_idx" ON "sites" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "sites_is_active_idx" ON "sites" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_locations_name_idx" ON "client_locations" USING btree ("location_name");--> statement-breakpoint
--
-- Data backfill (hand-written; drizzle-kit only emits DDL).
--
-- The geofence moved from client_locations to sites. Every existing location
-- becomes a location plus one site carrying the coordinates it used to hold, so
-- no geofence is lost. Migration 0006 drops the old columns only after this has
-- run.
--
INSERT INTO "sites" ("location_id", "site_name", "latitude", "longitude", "allowed_radius_meters")
SELECT
	"id",
	"location_name",
	"latitude",
	"longitude",
	COALESCE("allowed_radius_meters", '100')
FROM "client_locations"
WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;--> statement-breakpoint
--
-- Re-point employee assignments at the site that replaced their location. The
-- join is unambiguous because the insert above created exactly one site per
-- location.
--
INSERT INTO "employee_sites" ("employee_id", "site_id")
SELECT el."employee_id", s."id"
FROM "employee_locations" el
JOIN "sites" s ON s."location_id" = el."location_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
--
-- Same for historical punches, so existing logs keep pointing at a real place.
--
UPDATE "attendance_logs" al
SET "site_id" = s."id"
FROM "sites" s
WHERE s."location_id" = al."location_id" AND al."site_id" IS NULL;