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

    employeeId: uuid('employee_id').notNull().unique().references(()=>employees.id, { onDelete: 'cascade' }),
    phone: varchar('phone', { length: 15 }).notNull().unique(),
    password: varchar('password', { length: 66 }),
    salt: text('salt'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').$onUpdate(() => new Date()),
})


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
   
    department:  varchar('department',  { length: 100 }),
    designation: varchar('designation', { length: 100 }),
 
    // Face biometrics — 128-d FaceNet descriptor from face-api.js
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
    locationId: uuid('location_id')
      .references(() => clientLocations.id),
 
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

export const clientLocations = pgTable('client_locations', {
  id: uuid('id').primaryKey().defaultRandom(),

  locationName: varchar('location_name', {
    length: 200,
  }).notNull(),

  latitude: numeric('latitude', {
    precision: 10,
    scale: 7,
  }).notNull(),

  longitude: numeric('longitude', {
    precision: 10,
    scale: 7,
  }).notNull(),

  allowedRadiusMeters: numeric(
    'allowed_radius_meters',
    {
      precision: 8,
      scale: 2,
    }
  ).default('100'),

  isActive: boolean('is_active')
    .notNull()
    .default(true),

  createdAt: timestamp('created_at')
    .defaultNow()
    .notNull(),
});

export const employeeLocations = pgTable(
  'employee_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    employeeId: uuid('employee_id')
      .references(() => employees.id, {
        onDelete: 'cascade',
      })
      .notNull(),

    locationId: uuid('location_id')
      .references(() => clientLocations.id, {
        onDelete: 'cascade',
      })
      .notNull(),
  }
);
 
// ── Type exports (inferred from schema) ──────────────────────────────────────
export type Employee        = typeof employees.$inferSelect;
export type NewEmployee     = typeof employees.$inferInsert;
export type AttendanceLog   = typeof attendanceLogs.$inferSelect;
export type NewAttendanceLog = typeof attendanceLogs.$inferInsert;