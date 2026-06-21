import { z } from 'zod'


export const signupPayloadModel = z.object({
    firstName: z.string().min(2),
    lastName: z.string().nullable().optional(),
    phone: z.string().min(10).max(15),
    password: z.string().min(5)
})

export const signinPayloadModel = z.object({
    phone: z.string().min(10).max(15),
    password: z.string().min(5)
})

export const registerByPhoneModel = z.object({
  phone: z
    .string()
    .regex(/^[6-9]\d{9}$/, 'Invalid mobile number'),
});

