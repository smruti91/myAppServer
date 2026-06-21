CREATE TABLE "attendance_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"action" varchar(10) NOT NULL,
	"face_distance" numeric(6, 4),
	"geo_lat" numeric(10, 7),
	"geo_lng" numeric(10, 7),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"department" varchar(100),
	"designation" varchar(100),
	"face_embedding" vector(128),
	"has_registered_face" boolean DEFAULT false NOT NULL,
	"face_registered_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "att_logs_employee_date_idx" ON "attendance_logs" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "att_logs_date_idx" ON "attendance_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "att_logs_action_idx" ON "attendance_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "employees_face_embedding_idx" ON "employees" USING btree ("face_embedding");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_phone_idx" ON "employees" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "employees_is_active_idx" ON "employees" USING btree ("is_active");