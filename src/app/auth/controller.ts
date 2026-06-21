import type { Request, Response } from 'express'
import { randomBytes, createHmac } from 'node:crypto'
import { signinPayloadModel, 
        signupPayloadModel, 
        registerByPhoneModel, 
        
    } from './models'
import { db } from '../../db'
import { usersTable, employees, clientLocations, employeeLocations } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { createUserToken } from './utils/token'
import type { UserTokenPayload } from './utils/token'

class AuthenticationController {
    // public async handleSignup(req: Request, res: Response) {
    //     const validationResult = await signupPayloadModel.safeParseAsync(req.body)

    //     if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

    //     const { firstName, lastName, phone, password } = validationResult.data

    //     const userPhoneResult = await db.select().from(usersTable).where(eq(usersTable.phone, phone))

    //     if (userPhoneResult.length > 0) return res.status(400).json({ error: 'duplicate entry', message: `user with email ${phone} already exists` })

    //     const salt = randomBytes(32).toString('hex')
    //     const hash = createHmac('sha256', salt).update(password).digest('hex')

    //     const [result] = await db.insert(usersTable).values({
    //         firstName,
    //         lastName,
    //         phone,
    //         password: hash,
    //         salt
    //     }).returning({ id: usersTable.id })

    //     return res.status(201).json({ message: 'user has been created successfully', data: { id: result?.id } })
    // }

    public async registerByPhone(req: Request,res: Response) {
        try {
            const validationResult = await registerByPhoneModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { phone } = validationResult.data;

            // STEP 1: Check user already exists
            const existingUser = await db.query.usersTable.findFirst({
            where: eq(usersTable.phone, phone),
            });

            if (existingUser) {
            res.status(409).json({
                success: false,
                message: 'User already registered',
            });
            return;
            }

            // STEP 2: Check employee exists
            const employee = await db.query.employees.findFirst({
            where: eq(employees.phone, phone),
            });

            if (!employee) {
            res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
            return;
            }

            // STEP 3: Create default password
            const defaultPassword = '12345';

            const salt = randomBytes(32).toString('hex')
            const hash = createHmac('sha256', salt).update(defaultPassword).digest('hex')

            // STEP 4: Create user
           const result = await db.transaction(async (tx) => {

                const [newUser] = await tx
                .insert(usersTable)
                .values({
                employeeId: employee.id,
                phone: employee.phone,
                password: hash,
                salt
                })
                .returning();

                await tx
                .update(employees)
                .set({
                userId: newUser?.id,
                })
                .where(eq(employees.id, employee.id));

                return newUser;
                });

            res.status(201).json({
            success: true,
            message: 'Account created successfully',
            data: {
                userId: result?.id,
                employeeId: employee.id,
                phone: result?.phone,
                defaultPassword,
            },
            });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
            success: false,
            message: error.message,
            });
        }
        };

    public async handleSignin(req: Request, res: Response) {
        const validationResult = await signinPayloadModel.safeParseAsync(req.body)

        if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

        const { phone, password } = validationResult.data

        const [userSelect] = await db.select().from(usersTable).where(eq(usersTable.phone, phone))

        if (!userSelect) return res.status(404).json({ message: `user with email ${phone} does not exists` })

        const salt = userSelect.salt!
        const hash = createHmac('sha256', salt).update(password).digest('hex')

        if (userSelect.password !== hash) return res.status(400).json({ message: `email or password is incorrect` })

        const token = createUserToken({ id: userSelect.id })

        const [employee] = await db
            .select()
            .from(employees)
            .where(
            eq(employees.id, userSelect.employeeId!)
            );

        if (!employee) {
            return res.status(404).json({
                message: 'Employee not found'
            });
        }
        const locations = await db
            .select({
            id: clientLocations.id,
            locationName:
                clientLocations.locationName,
            latitude: clientLocations.latitude,
            longitude: clientLocations.longitude,
            allowedRadiusMeters:
                clientLocations.allowedRadiusMeters,
            })
            .from(employeeLocations)
            .innerJoin(
            clientLocations,
            eq(
                employeeLocations.locationId,
                clientLocations.id
            )
            )
            .where(
            eq(
                employeeLocations.employeeId,
                employee.id
            )
            );


        return res.json({
                success: true,
                message: 'Signin Success',
                data: {
                token,

                user: {
                    id: userSelect.id,
                    phone: userSelect.phone,
                },

                employee: {
                    id: employee?.id,
                    firstName: employee?.firstName,
                    lastName: employee?.lastName,
                    department: employee?.department,
                    designation: employee?.designation,

                    hasRegisteredFace:
                    employee?.hasRegisteredFace,

                    faceRegisteredAt:
                    employee?.faceRegisteredAt,
                },

                locations,
                },
            });

    }

    public async handleMe(req: Request, res: Response) {
        // @ts-ignore
        const { id } = req.user! as UserTokenPayload

        const [userResult] = await db.select().from(usersTable).where(eq(usersTable.id, id))

        return res.json({
           
            phone: userResult?.phone
        })
    }
}

export default AuthenticationController