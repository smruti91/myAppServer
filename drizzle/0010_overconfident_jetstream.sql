-- `users` and `client_locations` were the last two tables still on bare
-- `timestamp`: a wall-clock reading with no clock attached. Their defaults call
-- now(), which under this database's Etc/UTC session writes UTC, while
-- node-postgres reads a bare timestamp back as *local* time — so every row came
-- out shifted by the server's offset.
--
-- The USING clause is explicit rather than relying on the session TimeZone at
-- migration time: the existing values were written as UTC, and that is what they
-- must be reinterpreted as, whatever timezone the session applying this happens
-- to have. Without it, running this under a non-UTC session would move every
-- historic row by that offset.
ALTER TABLE "client_locations" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "client_locations" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "client_locations" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "client_locations" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';
