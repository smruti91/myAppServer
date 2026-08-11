CREATE TABLE "report_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"file_path" varchar(500) NOT NULL,
	"original_name" varchar(255),
	"geo_lat" numeric(10, 7),
	"geo_lng" numeric(10, 7),
	"face_distance" numeric(6, 4),
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "roles" text[] DEFAULT '{employee}' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_submissions" ADD CONSTRAINT "report_submissions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_submissions_employee_idx" ON "report_submissions" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "report_submissions_date_idx" ON "report_submissions" USING btree ("submitted_at");