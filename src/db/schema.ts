import { pgTable, uuid, varchar, text, boolean, timestamp,  numeric,
  index,
  uniqueIndex,
  check, } from 'drizzle-orm/pg-core'

import { customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Custom pgvector type (128 dimensions) ─────────────────────────────────────
// Drizzle doesn't ship a first-class vector() column yet,
// so we define it via customType — works perfectly with pgvector.
const vector = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    // JS → Postgres: number[] → '[f1,f2,...,f128]'
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    // Postgres → JS: '[f1,f2,...,f128]' → number[]
    fromDriver(value: string): number[] {
      return value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(Number);
    },
  });

export const usersTable = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),

    // Nullable because an admin is not an employee. The unique constraint stays:
    // Postgres treats NULLs as distinct under UNIQUE, so any number of admin
    // rows can coexist while each employee still maps to at most one user.
    employeeId: uuid('employee_id').unique().references(()=>employees.id, { onDelete: 'cascade' }),
    phone: varchar('phone', { length: 15 }).notNull().unique(),
    password: varchar('password', { length: 66 }),
    salt: text('salt'),
    // 'employee' | 'admin' | 'superviser'. Kept for backward compat; new code reads `roles`.
    role: varchar('role', { length: 20 }).notNull().default('employee'),

    // Multiple roles per user. Populated at sign-up and editable from the admin
    // panel. Backfilled from `role` by migration 0011. Possible values:
    //   'employee'         — can check in/out (all users get this by default)
    //   'supervisor'       — can register other employees' faces on their phone
    //   'report_collector' — can submit daily reports with face auth + GPS
    roles: text('roles').array().notNull().default(sql`'{employee}'`),
    isActive: boolean('is_active').notNull().default(true),
    // withTimezone, like every other table here. A bare `timestamp` column takes
    // the wall-clock reading and forgets which clock it came from: `now()` writes
    // UTC, node-postgres reads it back as local, and the row silently shifts by
    // the server's offset.
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
})

// ── refresh_tokens ────────────────────────────────────────────────────────────
// Refresh-token rotation needs server-side state: on each refresh the presented
// token is revoked and a replacement issued, so a replayed token can be detected
// and rejected. Only the sha256 of the token is stored — a database leak alone
// does not yield usable credentials.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),

    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Lookup on refresh is by hash; revoke-all-for-user is by userId.
    tokenHashIdx: uniqueIndex('refresh_tokens_token_hash_idx').on(table.tokenHash),
    userIdx: index('refresh_tokens_user_idx').on(table.userId),
  })
);


// ── employees ─────────────────────────────────────────────────────────────────
export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id'),
    // Identity
    firstName:   varchar('first_name',  { length: 100 }).notNull(),
    lastName:    varchar('last_name',   { length: 100 }).notNull(),
    phone:       varchar('phone',       { length: 20  }).notNull().unique(),

    // Nullable: staff on the shop floor often have no work address, and phone is
    // the identifier everything else keys on. Unique all the same, so a typo that
    // duplicates a colleague's address is caught — Postgres treats NULLs as
    // distinct, so any number of employees without one still coexist.
    email:       varchar('email',       { length: 160 }).unique(),

    department:  varchar('department',  { length: 100 }),
    designation: varchar('designation', { length: 100 }),
 
    // Face biometrics — 128-d FaceNet descriptor from face-api.js
    imagePath:        varchar('image_path', { length: 255 }),
    faceEmbedding:     vector(512)('face_embedding'),
    hasRegisteredFace: boolean('has_registered_face').notNull().default(false),
    faceRegisteredAt:  timestamp('face_registered_at', { withTimezone: true }),
 
    // Meta
    isActive:  boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // ivfflat ANN index for cosine similarity search
    // Built in migration (see migrations below) — Drizzle can't express
    // WITH (lists=100) directly so we use a raw SQL index helper
    faceEmbeddingIdx: index('employees_face_embedding_idx').on(table.faceEmbedding),
 
    // Faster employee lookups
    phoneIdx:     uniqueIndex('employees_phone_idx').on(table.phone),
    isActiveIdx:  index('employees_is_active_idx').on(table.isActive),
  })
);
 
// ── attendance_logs ───────────────────────────────────────────────────────────
export const attendanceLogs = pgTable(
  'attendance_logs',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    employeeId:   uuid('employee_id')
                    .notNull()
                    .references(() => employees.id, { onDelete: 'cascade' }),
 
    // 'check-in' | 'check-out'
    action:       varchar('action', { length: 10 }).notNull(),

    // The site the punch was made at — not the parent location. A location can
    // span several sites kilometres apart, so only the site identifies where the
    // employee actually stood. The parent location is reachable via sites.locationId.
    siteId: uuid('site_id')
      .references(() => sites.id),

    // Cosine distance at time of scan — useful for audit / threshold tuning
    faceDistance: numeric('face_distance', { precision: 6, scale: 4 }),
 
    // Optional: store geo coords for server-side geo-fence audit
    geoLat: numeric('geo_lat', { precision: 10, scale: 7 }),
    geoLng: numeric('geo_lng', { precision: 10, scale: 7 }),
 
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Primary query pattern: employee + date range
    employeeDateIdx: index('att_logs_employee_date_idx').on(
      table.employeeId,
      table.createdAt
    ),
    // Reports by date
    dateIdx: index('att_logs_date_idx').on(table.createdAt),
    // Filter by action
    actionIdx: index('att_logs_action_idx').on(table.action),
  })
);

// ── client_locations ──────────────────────────────────────────────────────────
// A location is an organisational bucket — a client, a city, a branch — that
// groups the sites beneath it. It deliberately carries NO coordinates: a location
// can span several sites kilometres apart, so a single lat/lng for it would be
// meaningless and, worse, ambiguous about which one a geofence check should use.
// The geofence lives on `sites`, which is the only place it exists.
export const clientLocations = pgTable(
  'client_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    locationName: varchar('location_name', {
      length: 200,
    }).notNull(),

    // Free-form context for the back office; not used in any check.
    city: varchar('city', { length: 120 }),
    siteCode: varchar('site_code', { length: 50 }),
    address: text('address'),

    isActive: boolean('is_active')
      .notNull()
      .default(true),

    // withTimezone for the same reason as users: a bare timestamp column stores
    // a reading with no clock attached and drifts by the server's offset.
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // The create endpoint already rejects duplicate names; enforcing it here
    // means a race between two concurrent creates can't slip one through.
    locationNameIdx: uniqueIndex('client_locations_name_idx').on(table.locationName),
  })
);

// ── sites ─────────────────────────────────────────────────────────────────────
// Where employees actually work, and the unit the geofence is defined on.
export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    locationId: uuid('location_id')
      .references(() => clientLocations.id, { onDelete: 'cascade' })
      .notNull(),

    siteName: varchar('site_name', { length: 200 }).notNull(),
    // Optional short identifier the client already uses on their own paperwork.
    siteCode: varchar('site_code', { length: 50 }),
    address: text('address'),

    // Same precision as attendance_logs.geo_lat/geo_lng so a distance comparison
    // never has to round one side. 7 decimal places is ~1 cm — far finer than any
    // phone GPS fix, and the smallest radius worth setting is metres.
    latitude: numeric('latitude', { precision: 10, scale: 7 }).notNull(),
    longitude: numeric('longitude', { precision: 10, scale: 7 }).notNull(),

    // notNull with a default, unlike the old nullable column: a site without a
    // radius cannot be geofenced at all, and silently treating null as "no limit"
    // would let anyone punch in from anywhere.
    allowedRadiusMeters: numeric('allowed_radius_meters', {
      precision: 8,
      scale: 2,
    })
      .notNull()
      .default('100'),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // Names only have to be unique within their location — two clients may both
    // have a "Gate 2".
    locationSiteIdx: uniqueIndex('sites_location_name_idx').on(
      table.locationId,
      table.siteName
    ),
    locationIdx: index('sites_location_idx').on(table.locationId),
    isActiveIdx: index('sites_is_active_idx').on(table.isActive),

    // Coordinates swapped into the wrong columns is the classic bug here, and it
    // stays invisible until someone can't check in. Longitude beyond ±90 is the
    // one case the database itself can catch.
    latRange: check('sites_lat_range', sql`${table.latitude} BETWEEN -90 AND 90`),
    lngRange: check('sites_lng_range', sql`${table.longitude} BETWEEN -180 AND 180`),
    radiusPositive: check('sites_radius_positive', sql`${table.allowedRadiusMeters} > 0`),
  })
);

// ── employee_sites ────────────────────────────────────────────────────────────
// Which sites an employee may check in at. Assignment is per-site, not per-
// location: being posted to a client's head office should not authorise a punch
// at their warehouse across town.
export const employeeSites = pgTable(
  'employee_sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    employeeId: uuid('employee_id')
      .references(() => employees.id, {
        onDelete: 'cascade',
      })
      .notNull(),

    siteId: uuid('site_id')
      .references(() => sites.id, {
        onDelete: 'cascade',
      })
      .notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The assign endpoint checks for an existing pair first; this closes the same
    // race the location-name index does.
    pairIdx: uniqueIndex('employee_sites_pair_idx').on(table.employeeId, table.siteId),
    // "who works at this site" — the reverse of the pair index, which can't serve it.
    siteIdx: index('employee_sites_site_idx').on(table.siteId),
  })
);

// ── report_submissions ────────────────────────────────────────────────────────
// One row per file a `report_collector` employee submits. The face-auth distance
// is captured so a supervisor can spot submissions where the face match was poor.
export const reportSubmissions = pgTable(
  'report_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    // Path relative to the server's uploads root (e.g. "reports/uuid.pdf").
    filePath: varchar('file_path', { length: 500 }).notNull(),
    originalName: varchar('original_name', { length: 255 }),

    // GPS recorded on the device at the moment of submission.
    geoLat: numeric('geo_lat', { precision: 10, scale: 7 }),
    geoLng: numeric('geo_lng', { precision: 10, scale: 7 }),

    // Cosine distance from the face-auth step — audit trail, not a gate.
    faceDistance: numeric('face_distance', { precision: 6, scale: 4 }),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    employeeIdx: index('report_submissions_employee_idx').on(table.employeeId),
    dateIdx:     index('report_submissions_date_idx').on(table.submittedAt),
  })
);

// ── Type exports (inferred from schema) ──────────────────────────────────────
export type Employee        = typeof employees.$inferSelect;
export type NewEmployee     = typeof employees.$inferInsert;
export type AttendanceLog   = typeof attendanceLogs.$inferSelect;
export type NewAttendanceLog = typeof attendanceLogs.$inferInsert;
export type ClientLocation  = typeof clientLocations.$inferSelect;
export type NewClientLocation = typeof clientLocations.$inferInsert;
export type Site            = typeof sites.$inferSelect;
export type NewSite         = typeof sites.$inferInsert;
export type EmployeeSite    = typeof employeeSites.$inferSelect;
export type ReportSubmission    = typeof reportSubmissions.$inferSelect;
export type NewReportSubmission = typeof reportSubmissions.$inferInsert;