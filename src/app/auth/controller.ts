import type { Request, Response } from 'express'
import { randomBytes, createHmac } from 'node:crypto'
import { signinPayloadModel, 
        signupPayloadModel, 
        registerByPhoneModel, 
        
    } from './models'
import { db } from '../../db'
import { usersTable, employees, clientLocations, employeeLocations, attendanceLogs } from '../../db/schema'
import { eq, desc } from 'drizzle-orm'
import { createUserToken } from './utils/token'
import type { UserTokenPayload } from './utils/token'
import { extractEmbedding, verifyFace, MATCH_THRESHOLD } from '../../services/faceService.js' // `extractEmbedding` is used by handleRegisterFace below.

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

    // ── Face registration ──────────────────────────────────────────────────
    // Accepts either multipart/form-data (file field "image") OR JSON with
    // { image: <base64> }. We normalize to a base64 string.
    public async handleRegisterFace(req: Request, res: Response) {
        try {
            // @ts-ignore — req.user is set by authMiddleware
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) {
                return res.status(400).json({ success: false, message: 'No image provided' });
            }

            // Find the user → employee
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            // Extract the 512-d embedding
            const embedding = await extractEmbedding(base64);
            if (!embedding) {
                return res.status(400).json({
                    success: false,
                    message: 'No face detected in the image. Please retry with good lighting.',
                });
            }

            // Save it to the employee row
            await db
                .update(employees)
                .set({
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt: new Date(),
                })
                .where(eq(employees.id, user.employeeId));

            return res.json({
                success: true,
                message: 'Face registered successfully',
                data: { dimensions: embedding.length },
            });
        } catch (err: any) {
            console.error('[register-face]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Face verification + attendance mark ────────────────────────────────
    public async handleMarkAttendance(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const action = (req.body?.action as string) || '';
            if (action !== 'check-in' && action !== 'check-out') {
                return res.status(400).json({ success: false, message: 'Invalid action' });
            }

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) {
                return res.status(400).json({ success: false, message: 'No image provided' });
            }

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const [employee] = await db
                .select()
                .from(employees)
                .where(eq(employees.id, user.employeeId));

            if (!employee?.hasRegisteredFace || !employee.faceEmbedding) {
                return res.status(400).json({
                    success: false,
                    verified: false,
                    message: 'Face not registered yet. Please register first.',
                });
            }

            // Ask the Python face-service to compare live image vs stored embedding.
            // /verify detects the face AND compares it in one pass, so there is no
            // separate extractEmbedding() call here — that would run InsightFace
            // twice over the same image and double the wait for the user.
            const { success, verified, distance, message } = await verifyFace(
                base64,
                employee.faceEmbedding as number[],
                MATCH_THRESHOLD
            );

            if (!success) {
                // Most common cause: no face in frame / too dark / too blurry.
                return res.status(400).json({
                    success: false,
                    verified: false,
                    message: message || 'No face detected. Please retry.',
                });
            }

            if (!verified) {
                return res.status(401).json({
                    success: false,
                    verified: false,
                    message: `Face does not match (distance=${distance.toFixed(3)})`,
                    data: { distance, threshold: MATCH_THRESHOLD },
                });
            }

            // Log the attendance — distance stored as string for the numeric column
            await db.insert(attendanceLogs).values({
                employeeId: employee.id,
                action,
                faceDistance: distance.toFixed(4),
            });

            return res.json({
                success: true,
                verified: true,
                message: `Successfully checked ${action === 'check-in' ? 'in' : 'out'}`,
                data: {
                    action,
                    at: new Date().toISOString(),
                },
            });
        } catch (err: any) {
            console.error('[attendance/mark]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Attendance history ────────────────────────────────────────────────────
    public async handleAttendanceHistory(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 200);
            const logs = await db
                .select()
                .from(attendanceLogs)
                .where(eq(attendanceLogs.employeeId, user.employeeId))
                .orderBy(desc(attendanceLogs.createdAt))
                .limit(limit);

            return res.json({
                success: true,
                data: {
                    logs: logs.map(l => ({
                        id: l.id,
                        action: l.action,
                        date: l.createdAt,
                        faceDistance: l.faceDistance,
                    })),
                },
            });
        } catch (err: any) {
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // Helper: parse base64 out of either JSON body or multipart upload
    private extractBase64FromRequest(req: Request): string | null {
        // multipart/form-data path (what the mobile app sends)
        // @ts-ignore
        const file = (req as any).file;
        if (file?.buffer) {
            return file.buffer.toString('base64');
        }
        // multer with memoryStorage: req.files for multi-part, but we use single.
        // JSON path fallback (for testing with Postman)
        const json = (req.body ?? {}) as { image?: string };
        if (typeof json.image === 'string' && json.image.length > 100) {
            return json.image;
        }
        return null;
    }
}

export default AuthenticationController