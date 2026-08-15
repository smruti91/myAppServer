import type { Request, Response } from 'express'
import { randomBytes, createHmac } from 'node:crypto'
import { signinPayloadModel, 
        signupPayloadModel, 
        registerByPhoneModel, 
        
    } from './models'
import { db } from '../../db'
import { usersTable, employees, clientLocations, sites, employeeSites, attendanceLogs } from '../../db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { createUserToken } from './utils/token'
import type { UserTokenPayload } from './utils/token'
import { extractEmbedding, verifyFace, MATCH_THRESHOLD } from '../../services/faceService.js' // `extractEmbedding` is used by handleRegisterFace below.
import { saveFaceImage, deleteFaceImage } from '../../services/faceImageStore'
import { saveReportFile } from '../../services/reportStore'
import { reportSubmissions } from '../../db/schema'
import {
    evaluateAction,
    checkoutAvailableAt,
    MIN_CHECKOUT_GAP_MINUTES,
    type LastPunch,
} from '../../services/attendanceRules'

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

        // Admins have no employee record (employeeId is null), so the employee
        // lookup below would fail with a misleading "Employee not found". Reject
        // explicitly and point them at the web panel instead.
        if (userSelect.role === 'admin') {
            return res.status(403).json({
                message: 'Admin accounts sign in through the web admin panel, not the mobile app',
            })
        }

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
        const locations = await this.loadEmployeeSites(employee.id);

        return res.json({
                success: true,
                message: 'Signin Success',
                data: {
                token,

                user: {
                    id: userSelect.id,
                    phone: userSelect.phone,
                    // Array of role strings. Falls back to the legacy scalar `role`
                    // so a row that was never backfilled still returns something
                    // useful rather than an empty array.
                    roles: (userSelect.roles?.length ?? 0) > 0
                        ? userSelect.roles
                        : [userSelect.role ?? 'employee'],
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

            // Keep the frame the enrolment was built from. Written only after the
            // embedding succeeded, so a rejected capture never leaves a file behind.
            const [existing] = await db
                .select({ imagePath: employees.imagePath })
                .from(employees)
                .where(eq(employees.id, user.employeeId));

            const imagePath = await saveFaceImage(user.employeeId, base64);

            // Save it to the employee row
            await db
                .update(employees)
                .set({
                    // Leave the previous photo in place if this frame could not be
                    // written — a stale image beats none, and the embedding, which
                    // is what attendance runs on, was updated either way.
                    ...(imagePath ? { imagePath } : {}),
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt: new Date(),
                })
                .where(eq(employees.id, user.employeeId));

            // Only once the row points at the new file — dropping it earlier would
            // leave the column referencing a path that no longer exists if the
            // update failed.
            if (imagePath && existing?.imagePath) await deleteFaceImage(existing.imagePath);

            return res.json({
                success: true,
                message: 'Face registered successfully',
                data: { dimensions: embedding.length, imagePath },
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

            // Sequence rules run before the face check on purpose: verification is
            // a multi-second round trip to the face service, and there is no sense
            // spending it on a punch that is going to be refused anyway.
            const last = await this.lastPunch(user.employeeId);
            const verdict = evaluateAction(action, last, new Date());
            if (!verdict.ok) {
                return res.status(409).json({
                    success: false,
                    verified: false,
                    message: verdict.message,
                    data: {
                        code: verdict.code,
                        minutesRemaining: verdict.minutesRemaining,
                        lastAction: last?.action ?? null,
                        lastActionAt: last?.createdAt ?? null,
                    },
                });
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

            // Log the attendance — distance stored as string for the numeric column.
            // `created_at` is left to its default: the database clock is the one
            // authority every row shares, and a phone with a wrong clock (or a
            // deliberately altered one) must not be able to backdate a punch.
            const [logged] = await db.insert(attendanceLogs).values({
                employeeId: employee.id,
                action,
                faceDistance: distance.toFixed(4),
            }).returning({ createdAt: attendanceLogs.createdAt });

            return res.json({
                success: true,
                verified: true,
                message: `Successfully checked ${action === 'check-in' ? 'in' : 'out'}`,
                data: {
                    action,
                    // The stored instant, in UTC ISO-8601. Clients render it in
                    // their own zone — sending a pre-formatted local string would
                    // be a second, unparseable source of truth.
                    at: (logged?.createdAt ?? new Date()).toISOString(),
                    checkoutAvailableAt:
                        action === 'check-in' && logged
                            ? checkoutAvailableAt(logged.createdAt).toISOString()
                            : null,
                },
            });
        } catch (err: any) {
            console.error('[attendance/mark]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /** The employee's most recent punch — the row every sequence rule is judged against. */
    private async lastPunch(employeeId: string): Promise<LastPunch> {
        const [row] = await db
            .select({ action: attendanceLogs.action, createdAt: attendanceLogs.createdAt })
            .from(attendanceLogs)
            .where(eq(attendanceLogs.employeeId, employeeId))
            .orderBy(desc(attendanceLogs.createdAt))
            .limit(1);

        return row ?? null;
    }

    /**
     * Where the employee stands right now: checked in or not, since when, and
     * whether check-out has unlocked.
     *
     * The app needs this on launch. It used to hold "checked in" in component
     * state alone, so force-quitting the app presented a fresh Check In button to
     * someone who was already checked in.
     */
    public async handleAttendanceStatus(req: Request, res: Response) {
        try {
            // @ts-ignore — req.user is set by authMiddleware
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const last = await this.lastPunch(user.employeeId);
            const isCheckedIn = last?.action === 'check-in';
            const availableAt = isCheckedIn ? checkoutAvailableAt(last!.createdAt) : null;

            return res.json({
                success: true,
                data: {
                    // Every instant is UTC ISO-8601; the client formats for its zone.
                    lastAction: last?.action ?? null,
                    lastActionAt: last?.createdAt?.toISOString() ?? null,
                    isCheckedIn,
                    checkoutAvailableAt: availableAt?.toISOString() ?? null,
                    canCheckOut: isCheckedIn && evaluateAction('check-out', last, new Date()).ok,
                    minCheckoutGapMinutes: MIN_CHECKOUT_GAP_MINUTES,
                    // Lets the app spot a device clock that disagrees with the
                    // server, which is what its countdown is really counting.
                    serverTime: new Date().toISOString(),
                },
            });
        } catch (err: any) {
            console.error('[attendance/status]', err);
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

    /**
     * The sites this employee may check in at, each with its own geofence.
     *
     * The response key callers see stays `locations` and every field the mobile
     * app reads (`locationName`, `latitude`, `longitude`, `allowedRadiusMeters`)
     * is present, so an installed app keeps working unchanged — `locationName`
     * now holds the *site* name, which is what it was really showing anyway.
     * `siteName` and the parent location are additive.
     *
     * Shared by sign-in and /my-sites so the geofence the app enforces can never
     * be one query's idea of the assignment and the other's.
     */
    private async loadEmployeeSites(employeeId: string) {
        return db
            .select({
                id: sites.id,
                locationName: sites.siteName,
                siteName: sites.siteName,
                latitude: sites.latitude,
                longitude: sites.longitude,
                allowedRadiusMeters: sites.allowedRadiusMeters,
                locationId: clientLocations.id,
                parentLocationName: clientLocations.locationName,
            })
            .from(employeeSites)
            .innerJoin(sites, eq(employeeSites.siteId, sites.id))
            .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
            .where(
                and(
                    eq(employeeSites.employeeId, employeeId),
                    // A deactivated site must stop authorising punches immediately,
                    // without having to unassign every employee one by one.
                    eq(sites.isActive, true)
                )
            );
    }

    /**
     * Current geofences for the signed-in employee.
     *
     * Sign-in already returns these, but the app persists them and a session can
     * outlive several admin edits — a site moved, its radius widened, or a new
     * posting added. Without a way to re-read them the app would keep enforcing
     * whatever was true the day the employee last logged in.
     */
    public async handleMySites(req: Request, res: Response) {
        try {
            // @ts-ignore — req.user is set by authMiddleware
            const userId = req.user?.id as string | undefined;
            if (!userId) {
                return res.status(401).json({ success: false, message: 'Authentication required' });
            }

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user || !user.employeeId) {
                return res.status(404).json({ success: false, message: 'Employee not linked' });
            }

            const locations = await this.loadEmployeeSites(user.employeeId);

            return res.json({ success: true, data: { locations } });
        } catch (err: any) {
            console.error('[my-sites]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: look up employee by phone ────────────────────────────────
    // The supervisor enters the employee's phone number on their device; this
    // returns just enough info to confirm they have the right person before the
    // face-capture step.
    public async handleEmployeeByPhone(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user?.roles?.includes('supervisor')) {
                return res.status(403).json({ success: false, message: 'Supervisor role required' });
            }

            const phone = (req.query.phone as string ?? '').trim();
            if (!phone) return res.status(400).json({ success: false, message: 'phone query param required' });

            const [emp] = await db
                .select({
                    id:               employees.id,
                    firstName:        employees.firstName,
                    lastName:         employees.lastName,
                    designation:      employees.designation,
                    hasRegisteredFace: employees.hasRegisteredFace,
                })
                .from(employees)
                .where(eq(employees.phone, phone));

            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            return res.json({ success: true, data: emp });
        } catch (err: any) {
            console.error('[supervisor/employee-by-phone]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Supervisor: register face for another employee ───────────────────────
    // Body (multipart): `employeePhone` text field + `image` file field.
    // The supervisor is already authenticated via JWT; no face-check of the
    // supervisor is needed. The captured frame is of the *target* employee.
    public async handleSupervisorRegisterFace(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user?.roles?.includes('supervisor')) {
                return res.status(403).json({ success: false, message: 'Supervisor role required' });
            }

            const employeePhone = (req.body?.employeePhone as string ?? '').trim();
            if (!employeePhone) {
                return res.status(400).json({ success: false, message: 'employeePhone is required' });
            }

            const base64 = this.extractBase64FromRequest(req);
            if (!base64) return res.status(400).json({ success: false, message: 'No image provided' });

            const [emp] = await db
                .select()
                .from(employees)
                .where(eq(employees.phone, employeePhone));

            if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

            const embedding = await extractEmbedding(base64);
            if (!embedding) {
                return res.status(400).json({
                    success: false,
                    message: 'No face detected in the image. Please retry with good lighting.',
                });
            }

            const [existing] = await db
                .select({ imagePath: employees.imagePath })
                .from(employees)
                .where(eq(employees.id, emp.id));

            const imagePath = await saveFaceImage(emp.id, base64);

            await db
                .update(employees)
                .set({
                    ...(imagePath ? { imagePath } : {}),
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt: new Date(),
                })
                .where(eq(employees.id, emp.id));

            if (imagePath && existing?.imagePath) await deleteFaceImage(existing.imagePath);

            return res.json({
                success: true,
                message: `Face registered for ${emp.firstName} ${emp.lastName}`,
                data: { employeeId: emp.id, dimensions: embedding.length, imagePath },
            });
        } catch (err: any) {
            console.error('[supervisor/register-face]', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── Report collector: submit daily report ────────────────────────────────
    // Multipart fields:
    //   image  — face frame for authentication (same /verify pipeline as attendance)
    //   file   — the report document (PDF / Excel / CSV)
    //   lat    — device GPS latitude  (optional but encouraged)
    //   lng    — device GPS longitude (optional)
    public async handleSubmitReport(req: Request, res: Response) {
        try {
            // @ts-ignore
            const userId = req.user?.id as string | undefined;
            if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
            if (!user?.roles?.includes('report_collector')) {
                return res.status(403).json({ success: false, message: 'report_collector role required' });
            }

            if (!user.employeeId) return res.status(404).json({ success: false, message: 'Employee not linked' });

            // ── face auth ─────────────────────────────────────────────────
            const faceBase64 = this.extractBase64FromField(req, 'image');
            if (!faceBase64) return res.status(400).json({ success: false, message: 'Face image required' });

            const [emp] = await db.select().from(employees).where(eq(employees.id, user.employeeId));
            if (!emp?.hasRegisteredFace || !emp.faceEmbedding) {
                return res.status(400).json({ success: false, message: 'Face not registered. Please register first.' });
            }

            const { success, verified, distance, message } = await verifyFace(
                faceBase64,
                emp.faceEmbedding as number[],
                MATCH_THRESHOLD,
            );
            if (!success) return res.status(400).json({ success: false, verified: false, message: message || 'No face detected' });
            if (!verified) {
                return res.status(401).json({
                    success: false, verified: false,
                    message: `Face does not match (distance=${distance.toFixed(3)})`,
                    data: { distance, threshold: MATCH_THRESHOLD },
                });
            }

            // ── report file ───────────────────────────────────────────────
            const reportFile = (req as any).files?.file?.[0] as Express.Multer.File | undefined;
            if (!reportFile?.buffer) {
                return res.status(400).json({ success: false, message: 'Report file required (field: file)' });
            }

            const filePath = await saveReportFile(emp.id, reportFile.buffer, reportFile.originalname);

            // ── GPS ───────────────────────────────────────────────────────
            const lat = req.body?.lat ? String(req.body.lat) : null;
            const lng = req.body?.lng ? String(req.body.lng) : null;

            const [submission] = await db
                .insert(reportSubmissions)
                .values({
                    employeeId:   emp.id,
                    filePath,
                    originalName: reportFile.originalname ?? null,
                    geoLat:       lat,
                    geoLng:       lng,
                    faceDistance: distance.toFixed(4),
                })
                .returning({ id: reportSubmissions.id, submittedAt: reportSubmissions.submittedAt });

            return res.json({
                success: true,
                message: 'Report submitted successfully',
                data: {
                    id:          submission?.id,
                    submittedAt: submission?.submittedAt,
                    filePath,
                    geoLat: lat,
                    geoLng: lng,
                },
            });
        } catch (err: any) {
            console.error('[reports/submit]', err);
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

    /**
     * Like extractBase64FromRequest, but targets a specific named field inside
     * req.files (multer fields() upload). Used when a request carries both an
     * image field and a file field so the two don't collide on req.file.
     */
    private extractBase64FromField(req: Request, fieldName: string): string | null {
        const files = (req as any).files as Record<string, Express.Multer.File[]> | undefined;
        const file = files?.[fieldName]?.[0];
        if (file?.buffer) return file.buffer.toString('base64');

        // JSON fallback (Postman / tests)
        const json = (req.body ?? {}) as Record<string, string>;
        const val = json[fieldName];
        if (typeof val === 'string' && val.length > 100) return val;
        return null;
    }
}

export default AuthenticationController