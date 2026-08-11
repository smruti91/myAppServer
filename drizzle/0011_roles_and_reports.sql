-- Migration 0011: multi-role users + report submissions
--
-- 1. Add `roles text[]` to users.
--    The existing `role` column stays (backward compat), but all new code reads
--    `roles`. Backfill by wrapping the current single role into an array.
--
-- 2. Add `report_submissions` — rows written when a report-collector uploads a
--    daily/weekly report after face-authenticating on device.

-- ── 1. User roles ─────────────────────────────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "roles" text[] NOT NULL DEFAULT '{employee}';

-- Backfill: wrap each user's current role into the new array.
UPDATE "users" SET "roles" = ARRAY["role"];

-- ── 2. Report submissions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "report_submissions" (
  "id"            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  "employee_id"   uuid          NOT NULL
                                REFERENCES "employees"("id") ON DELETE CASCADE,

  -- Path under uploads/reports/ — same convention as uploads/faces/.
  "file_path"     varchar(500)  NOT NULL,
  -- The filename the collector chose, kept for display in the admin panel.
  "original_name" varchar(255),

  -- Device GPS at the moment the collector tapped Submit.
  "geo_lat"       numeric(10,7),
  "geo_lng"       numeric(10,7),

  -- Cosine distance from the face-auth step; stored for audit / threshold review.
  "face_distance" numeric(6,4),

  "submitted_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "report_submissions_employee_idx"
  ON "report_submissions" ("employee_id");

CREATE INDEX IF NOT EXISTS "report_submissions_date_idx"
  ON "report_submissions" ("submitted_at");
