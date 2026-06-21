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

  department: z
    .string()
    .max(100)
    .optional(),

  designation: z
    .string()
    .max(100)
    .optional(),

  isActive: z
    .boolean()
    .optional()
    .default(true),
});

export const createClientLocationModel = z.object({
  locationName: z
    .string()
    .min(2, 'Location name is required')
    .max(255),

  latitude: z
    .number(),
    

  longitude: z
    .number(),
    
  allowedRadiusMeters: z
    .number()
    .positive()
    .optional(),
});

export const assignLocationModel = z.object({
  employeeId: z.string().uuid(),
  locationId: z.string().uuid(),
});

export type CreateEmployeeInput =
  z.infer<typeof createEmployeeSchema>;