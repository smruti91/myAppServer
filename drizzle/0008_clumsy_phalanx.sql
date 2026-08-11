ALTER TABLE "employees" ADD COLUMN "email" varchar(160);--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_email_unique" UNIQUE("email");