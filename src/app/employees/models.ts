import { z } from 'zod';

export const createEmployeeSchema = z.object({
 
  firstName: z
    .string()
    .min(2, 'First name must be at least 2 characters')
    .max(100),

  lastName: z
    .string()
    .max(100),
    

  phone: z
    .string()
    .regex(
      /^[6-9]\d{9}$/,
      'Please enter a valid 10 digit mobile number'
    ),

  // Nullable as well as optional so the admin form can clear a field that was
  // previously filled — `.optional()` alone rejects the `null` a cleared input
  // sends. The column is nullable-unique, so blank is always allowed.
  email: z
    .string()
    .email('Please enter a valid email address')
    .max(160)
    .nullable()
    .optional(),

  department: z
    .string()
    .max(100)
    .nullable()
    .optional(),

  designation: z
    .string()
    .max(100)
    .nullable()
    .optional(),

  // The site this employee may check in at. Optional because an employee can be
  // created before their posting is known; `null` clears every assignment.
  siteId: z
    .string()
    .uuid('siteId must be a valid site id')
    .nullable()
    .optional(),

  isActive: z
    .boolean()
    .optional()
    .default(true),
});

/**
 * Partial update of an employee.
 *
 * Built by stripping the default off `isActive` first: `.partial()` keeps a
 * default, so an update that never mentions `isActive` would silently reactivate
 * a deactivated employee.
 */
export const updateEmployeeModel = createEmployeeSchema
  .omit({ isActive: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

/**
 * A location is now a grouping only — a client, a city, a branch. Coordinates
 * moved to `sites`, so they are no longer accepted here.
 */
export const createClientLocationModel = z.object({
  locationName: z
    .string()
    .min(2, 'Location name is required')
    .max(200),

  // Nullable as well as optional: the admin form sends `null` to clear a field
  // that was previously filled, and `.optional()` alone would reject that with a
  // 400 — leaving no way to undo a typo other than a database edit.
   siteCode: z
    .string()
    .max(50)
    .nullable()
    .optional(),

  address: z
    .string()
    .max(500)
    .nullable()
    .optional(),
});

/** A site under a location. This is the row that carries the geofence. */
export const createSiteModel = z.object({
  locationId: z.string().uuid('locationId must be a valid location id'),

  siteName: z
    .string()
    .min(2, 'Site name is required')
    .max(200),

  siteCode: z
    .string()
    .max(50)
    .nullable()
    .optional(),

  address: z
    .string()
    .max(500)
    .nullable()
    .optional(),

  // Bounded here as well as by the database CHECK: a zod failure returns a
  // readable 400, whereas the constraint surfaces as a raw Postgres error.
  latitude: z
    .number()
    .min(-90, 'latitude must be between -90 and 90')
    .max(90, 'latitude must be between -90 and 90'),

  longitude: z
    .number()
    .min(-180, 'longitude must be between -180 and 180')
    .max(180, 'longitude must be between -180 and 180'),

  // Optional on input only — the column itself is NOT NULL and defaults to 100 m.
  // An upper bound because a typo like 50000 would silently disable the geofence.
  allowedRadiusMeters: z
    .number()
    .positive('allowedRadiusMeters must be greater than 0')
    .max(10000, 'allowedRadiusMeters cannot exceed 10000')
    .optional(),
});

/**
 * Partial update of a location.
 *
 * `.partial()` alone would accept `{}` and issue a pointless UPDATE, so a
 * refinement requires at least one field. `isActive` is editable here because
 * deactivating is the non-destructive alternative to deleting a location whose
 * sites already carry attendance history.
 */
export const updateClientLocationModel = createClientLocationModel
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

/** Partial update of a site. `locationId` is included so a site can be re-parented. */
export const updateSiteModel = createSiteModel
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

/** Authorise an employee to check in at one site. */
export const assignSiteModel = z.object({
  employeeId: z.string().uuid(),
  siteId: z.string().uuid(),
});

/** Route params that are a bare uuid. */
export const idParamModel = z.object({
  id: z.string().uuid('Not a valid id'),
});

export type CreateEmployeeInput =
  z.infer<typeof createEmployeeSchema>;
export type CreateSiteInput = z.infer<typeof createSiteModel>;

const KNOWN_ROLES = ['employee', 'supervisor', 'report_collector'] as const

/**
 * Roles payload for PATCH /employees/:id/roles.
 * 'employee' is mandatory — it grants the check-in capability every user needs.
 */
export const updateEmployeeRolesModel = z.object({
  roles: z
    .array(z.enum(KNOWN_ROLES))
    .min(1, 'Assign at least one role')
    .refine((arr) => arr.includes('employee'), {
      message: "'employee' must always be included",
    }),
})

export type UpdateEmployeeRolesInput = z.infer<typeof updateEmployeeRolesModel>