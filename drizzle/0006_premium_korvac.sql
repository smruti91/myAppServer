ALTER TABLE "employee_locations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "employee_locations" CASCADE;--> statement-breakpoint
ALTER TABLE "attendance_logs" DROP CONSTRAINT "attendance_logs_location_id_client_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "attendance_logs" DROP COLUMN "location_id";--> statement-breakpoint
ALTER TABLE "client_locations" DROP COLUMN "latitude";--> statement-breakpoint
ALTER TABLE "client_locations" DROP COLUMN "longitude";--> statement-breakpoint
ALTER TABLE "client_locations" DROP COLUMN "allowed_radius_meters";