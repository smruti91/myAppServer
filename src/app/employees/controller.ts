import type { Request, Response } from 'express'
import { db } from '../../db'
import { attendanceLogs, employees, clientLocations, sites, employeeSites, usersTable } from '../../db/schema'
import { eq, and, or, ilike, desc, sql } from 'drizzle-orm';

import path from 'path';
import {
    createEmployeeSchema,
    updateEmployeeModel,
    createClientLocationModel,
    updateClientLocationModel,
    createSiteModel,
    updateSiteModel,
    assignSiteModel,
    idParamModel,
    updateEmployeeRolesModel,
} from './models';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { getEmbeddingFromSidecar } from '../utils/pythonSidecar';
import { saveFaceImage, deleteFaceImage } from '../../services/faceImageStore';
 

class EmployeesController {
    public async handleRegisterFace(req: Request, res: Response){
        
          const { image } = req.body as { image: string };
          const {empId } = req.body

         console.log(empId);
         //return;
          if (!image) {
                return res.status(400).json({ message: 'image (base64) is required' });
        }
        try {
             const embedding = await getEmbeddingFromSidecar(image);
                //  console.log(embedding);

                // Same as the mobile enrolment path: keep the frame the embedding
                // was built from so the enrolment can be reviewed later.
                const [existing] = await db
                    .select({ imagePath: employees.imagePath })
                    .from(employees)
                    .where(eq(employees.id, empId));

                const imagePath = await saveFaceImage(empId, image);

                // Drizzle customType handles number[] → '[f1,...,f512]' serialisation
                await db
                .update(employees)
                .set({
                    ...(imagePath ? { imagePath } : {}),
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt:  new Date(),
                })
                .where(eq(employees.id, empId));

                if (imagePath && existing?.imagePath) await deleteFaceImage(existing.imagePath);

                return res.status(200).json({
                message: 'Face registered successfully',
                data: { empId, embeddingDimensions: embedding.length, imagePath },
                });
        } catch (err: any) {
            if (err?.noFace) {
            return res.status(422).json({
                message: 'No face detected. Ensure good lighting and a clear front-facing photo.',
            });
            }
            console.error('[register-face]', err);
            return res.status(500).json({ message: 'Internal server error', detail: err.message });
        }
       
    }

    public async handleattendanceMark(req: Request, res: Response){
        const {
        image,
        action,
        empId
        }: {
        image: string;
        action: 'check-in' | 'check-out';
        empId: string;
        } = req.body;
        console.log(empId);
        const MATCH_THRESHOLD = 0.50;
        if (!image || !action)
            return res.status(400).json({ message: 'image and action are required' });
        if (!['check-in', 'check-out'].includes(action))
            return res.status(400).json({ message: 'action must be check-in or check-out' });
        
        try {
            // 1. Get 512-d embedding from Python sidecar
            const embedding = await getEmbeddingFromSidecar(image);
            const queryVec   = `[${embedding.join(',')}]`;
        
            // 2. pgvector cosine distance — scoped to this user (single row = O(1))
            //    <=> operator = cosine distance. Drizzle doesn't have a native helper
            //    so we use sql`` tagged template.
            const rows = await db.execute<{ id: string; distance: number }>(sql`
            SELECT id,
                    face_embedding <=> ${sql.raw(`'${queryVec}'::vector`)} AS distance
                FROM employees
            WHERE id                 = ${empId}
                AND has_registered_face = true
            LIMIT 1
            `);
        
            const row = rows.rows[0]; 
            if (!row) {
            return res.status(404).json({ message: 'No registered face found. Please register first.' });
            }
        
            const distance = Number(row.distance);
        
            if (distance > MATCH_THRESHOLD) {
            return res.status(401).json({
                message: 'Face verification failed. Please try again in better lighting.',
                debug: { distance: distance.toFixed(4), threshold: MATCH_THRESHOLD },
            });
            }
        
            // 3. Duplicate prevention
            if (action === 'check-in') {
            const existing = await db
                .select({ id: attendanceLogs.id })
                .from(attendanceLogs)
                .where(and(
                eq(attendanceLogs.employeeId, empId),
                eq(attendanceLogs.action, 'check-in'),
                sql`DATE(${attendanceLogs.createdAt}) = CURRENT_DATE`
                ))
                .limit(1);
        
            if (existing.length)
                return res.status(409).json({ message: 'Already checked in today.' });
            }
        
            if (action === 'check-out') {
           // Night shifts cross midnight, so "checked in today" is the wrong
                // gate. A check-out closes the most recent open duty: an open
                // check-in exists exactly when the latest punch is a check-in
                // (any later check-out would have closed it).
                const latest = await db
                    .select({ action: attendanceLogs.action })
                    .from(attendanceLogs)
                    .where(eq(attendanceLogs.employeeId, empId))
                    .orderBy(desc(attendanceLogs.createdAt))
                    .limit(1)
 
                if (latest[0]?.action !== 'check-in')
                    return res.status(409).json({ message: 'Cannot check out without checking in first.' })
            }
        
            // 4. Log attendance
            const [log] = await db
            .insert(attendanceLogs)
            .values({
                employeeId:   empId,
                action,
                faceDistance: distance.toFixed(4),
            })
            .returning({ id: attendanceLogs.id, createdAt: attendanceLogs.createdAt });
        
            return res.status(200).json({
            message: action === 'check-in' ? 'Checked in successfully' : 'Checked out successfully',
            data: {
                logId:        log?.id,
                action,
                timestamp:    log?.createdAt,
                faceDistance: parseFloat(distance.toFixed(4)),
            },
            });
        
        } catch (err: any) {
            if (err?.noFace) {
            return res.status(422).json({ message: 'No face detected. Please try again.' });
            }
            console.error('[mark-attendance]', err);
            return res.status(500).json({ message: 'Internal server error', detail: err.message });
        }
    }

     /**
     * Attendance report — one row per duty (a check-in paired with the next
     * check-out).
     *
     * Duties are paired chronologically per employee rather than by calendar
     * day, so a night shift — check-in 20:00, check-out 06:00 the next
     * morning — is one row dated by the check-in, with the full duty time.
     * A check-in with no check-out yet stays open (check-out '—').
     *
     * Paginated: the table requests fixed-size pages; omitting `pageSize`
     * (or sending <= 0) returns every matching row, which the Excel export
     * uses to dump the full filtered set rather than just the visible page.
     *
     * "Distance" is the geodesic distance in metres from the check-in's GPS
     * fix to its site's geofence centre, computed live rather than stored.
     * Check-ins recorded without a fix (geo_lat/geo_lng NULL) come back as
     * null and render as '—'.
     */
    public async attendanceReport(req: Request, res: Response){
        try {
            const from = (req.query.from as string | undefined)?.trim()
            const to = (req.query.to as string | undefined)?.trim()
            const siteId = (req.query.siteId as string | undefined)?.trim()
            const employeeId = (req.query.employeeId as string | undefined)?.trim()
 
            const pageRaw = Number(req.query.page)
            const sizeRaw = Number(req.query.pageSize)
            const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
            const pageSize = Number.isInteger(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 10000) : null
 
            // Filters shared by the count and the page/export queries. The CTE's
            // upper bound reaches one extra day past `to` so a night shift whose
            // check-out lands the next morning still finds its pair; only
            // check-ins strictly inside [from, to) become rows (emitFilter).
            // Time formatting and DATE() rely on the DB session's clock
            // (Asia/Kolkata), same as the punches.
            const conds = []
            if (from) conds.push(sql`al.created_at >= ${from}::date`)
            if (to) conds.push(sql`al.created_at < (${to}::date + interval '2 day')`)
            if (siteId && idParamModel.safeParse({ id: siteId }).success) conds.push(sql`al.site_id = ${siteId}`)
            if (employeeId && idParamModel.safeParse({ id: employeeId }).success) conds.push(sql`al.employee_id = ${employeeId}`)
 
            const whereSql = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``
 
            // A row is emitted for a check-in strictly inside the requested
            // window; check-ins that slipped into the CTE's widened range are
            // dropped (their check-outs are still available for pairing).
            const emitFilter = to ? sql`p.created_at < (${to}::date + interval '1 day')` : sql`true`
 
            // Every matching punch in time order per employee; `rn` lets each
            // check-in look at its immediate successor (see rows query below).
            const punchesCte = sql`
                select
                    al.id,
                    al.employee_id,
                    al.site_id,
                    al.action,
                    al.created_at,
                    al.geo_lat,
                    al.geo_lng,
                    row_number() over (
                        partition by al.employee_id
                        order by al.created_at
                    ) as rn
                from attendance_logs al
                ${whereSql}
            `
 
            // Only the paged view needs the total; the export path skips the
            // extra round trip and reports the rows it actually got.
            let total = 0
            if (pageSize) {
                const tally = await db.execute<{ count: number }>(sql`
                    with punches as (${punchesCte})
                    select count(*)::int as count
                    from punches p
                    where p.action = 'check-in' and ${emitFilter}
                `)
                total = tally.rows[0]?.count ?? 0
            }
 
            const rows = await db.execute<DailyReportRow>(sql`
                with punches as (${punchesCte})
                select
                    ci.id,
                    concat(e.first_name, ' ', e.last_name) as "employeeName",
                    s.site_name as "siteName",
                    to_char(ci.check_in_at, 'YYYY-MM-DD') as "createdAtDateOnly",
                    to_char(ci.check_in_at, 'HH24:MI:SS') as "checkIn",
                    to_char(ci.check_out_at, 'HH24:MI:SS') as "checkOut",
                    -- Duty time = check-out minus check-in, spanning midnight for
                    -- night shifts. Interval, so the gap between 20:00 and 06:00
                    -- is correctly 10 hours, not -14.
                    to_char(ci.check_out_at - ci.check_in_at, 'HH24:MI:SS') as "dutyTime",
                    round(
                        6371000 * 2 * asin(sqrt(
                            power(sin((radians(s.latitude) - radians(ci.geo_lat)) / 2), 2)
                            + cos(radians(ci.geo_lat)) * cos(radians(s.latitude))
                            * power(sin((radians(s.longitude) - radians(ci.geo_lng)) / 2), 2)
                        ))
                    )::double precision as "distanceM"
                from (
                    -- Pair each check-in with the very next punch; the join keeps
                    -- it only when that next punch is a check-out, so consecutive
                    -- check-ins (an anomaly) leave the earlier one open.
                    select
                        p.id,
                        p.employee_id,
                        p.site_id,
                        p.created_at as check_in_at,
                        p.geo_lat,
                        p.geo_lng,
                        co.created_at as check_out_at
                    from punches p
                    left join punches co
                        on co.employee_id = p.employee_id
                        and co.rn = p.rn + 1
                        and co.action = 'check-out'
                    where p.action = 'check-in' and ${emitFilter}
                ) ci
                join employees e on e.id = ci.employee_id
                left join sites s on s.id = ci.site_id
                order by ci.check_in_at desc, e.first_name, e.last_name, ci.employee_id
                ${pageSize ? sql`limit ${pageSize} offset ${(page - 1) * pageSize}` : sql``}
            `)
 
            if (!pageSize) total = rows.rows.length
 
            res.json({
                success: true,
                data: {
                    rows: rows.rows,
                    pagination: {
                        page,
                        pageSize: pageSize ?? rows.rows.length,
                        total,
                        totalPages: pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1,
                    },
                },
            })
        } catch (error: any) {
            console.error('[attendance-report]', error)
            // drizzle wraps DB failures in a "Query failed: …" message that dumps
            // the SQL — useless to an admin. The real Postgres error is on .cause.
            const detail = error?.cause?.message ?? error?.message
            res.status(500).json({ success: false, message: detail || 'Internal Server Error' })
        }
    }

    /**
     * The sites an employee is assigned to, as a JSON array on each row.
     *
     * Aggregated in SQL rather than fetched per employee: the alternative is one
     * query per row, and this list is the first screen an admin opens.
     */
    private readonly assignedSites = sql<
        { id: string; siteName: string; locationId: string; locationName: string }[]
    >`coalesce(
        json_agg(
            json_build_object(
                'id', ${sites.id},
                'siteName', ${sites.siteName},
                'locationId', ${clientLocations.id},
                'locationName', ${clientLocations.locationName}
            )
            order by ${sites.siteName}
        ) filter (where ${sites.id} is not null),
        '[]'::json
    )`

    /**
     * Replace an employee's site assignments.
     *
     * The admin form shows one site, so it owns the whole set: whatever it sends
     * becomes the assignment. Anything else would leave the form showing one site
     * while the employee could still punch in at another.
     */
    private async setEmployeeSite(tx: any, employeeId: string, siteId: string | null) {
        await tx.delete(employeeSites).where(eq(employeeSites.employeeId, employeeId))
        if (siteId) await tx.insert(employeeSites).values({ employeeId, siteId })
    }

    /** List employees with their site, optionally filtered. */
    public async listEmployees (req: Request, res: Response){
        try {
            const search = (req.query.search as string | undefined)?.trim()
            const status = req.query.status as string | undefined
            const siteId = req.query.siteId as string | undefined
            const locationId = req.query.locationId as string | undefined

            const conditions = []

            if (search) {
                const like = `%${search}%`
                conditions.push(
                    or(
                        ilike(employees.firstName, like),
                        ilike(employees.lastName, like),
                        ilike(employees.phone, like),
                        ilike(employees.email, like)
                    )
                )
            }

            if (status === 'active') conditions.push(eq(employees.isActive, true))
            if (status === 'inactive') conditions.push(eq(employees.isActive, false))

            // EXISTS rather than a condition on the join: filtering the join would
            // also strip the other sites out of the aggregate above, so a
            // multi-site employee would appear to have only the one filtered on.
            if (siteId && idParamModel.safeParse({ id: siteId }).success) {
                conditions.push(
                    sql`exists (select 1 from "employee_sites" es where es.employee_id = ${employees.id} and es.site_id = ${siteId})`
                )
            }

            if (locationId && idParamModel.safeParse({ id: locationId }).success) {
                conditions.push(
                    sql`exists (
                        select 1 from "employee_sites" es
                        join "sites" s on s.id = es.site_id
                        where es.employee_id = ${employees.id} and s.location_id = ${locationId}
                    )`
                )
            }

            const rows = await db
                .select({
                    id: employees.id,
                    firstName: employees.firstName,
                    lastName: employees.lastName,
                    phone: employees.phone,
                    email: employees.email,
                    department: employees.department,
                    designation: employees.designation,
                    isActive: employees.isActive,
                    imagePath: employees.imagePath,
                    hasRegisteredFace: employees.hasRegisteredFace,
                    faceRegisteredAt: employees.faceRegisteredAt,
                    createdAt: employees.createdAt,
                    updatedAt: employees.updatedAt,
                    // Scalar subquery: one user per employee, so no aggregation needed.
                    // Returns null when the employee has never signed in; fallback to ['employee'].
                    roles: sql<string[]>`coalesce((select roles from users u where u.employee_id = ${employees.id}), ARRAY['employee']::text[])`,
                    sites: this.assignedSites,
                })
                .from(employees)
                .leftJoin(employeeSites, eq(employeeSites.employeeId, employees.id))
                .leftJoin(sites, eq(sites.id, employeeSites.siteId))
                .leftJoin(clientLocations, eq(clientLocations.id, sites.locationId))
                .where(conditions.length ? and(...conditions) : undefined)
                .groupBy(employees.id)
                .orderBy(desc(employees.createdAt))

            res.json({ success: true, data: { employees: rows } });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async handleEployeeRegister(req: Request, res: Response){
        try {
            const validationResult = await createEmployeeSchema.safeParseAsync(req.body);

            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { firstName, lastName, phone, email, department, designation, siteId, isActive } =
                validationResult.data;

            const existingPhone = await db.query.employees.findFirst({
                where: eq(employees.phone, phone),
            });

            if (existingPhone) {
                return res.status(409).json({
                    success: false,
                    message: 'Phone number already exists',
                });
            }

            // Checked here as well as by the unique constraint so the form gets a
            // message it can put on the field rather than a raw Postgres error.
            if (email) {
                const existingEmail = await db.query.employees.findFirst({
                    where: eq(employees.email, email),
                });
                if (existingEmail) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another employee already uses that email address',
                    });
                }
            }

            if (siteId) {
                const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
                if (!site) {
                    return res.status(404).json({ success: false, message: 'Site not found' });
                }
            }

            // One transaction: an employee created without the site assignment the
            // admin asked for cannot check in anywhere, and nothing in the UI would
            // show that the second half failed.
            const employee = await db.transaction(async (tx) => {
                const [row] = await tx
                    .insert(employees)
                    .values({
                        firstName,
                        lastName,
                        phone,
                        email: email ?? null,
                        department: department ?? null,
                        designation: designation ?? null,
                        isActive: isActive ?? true,
                    })
                    .returning();

                if (row && siteId) await this.setEmployeeSite(tx, row.id, siteId)

                return row
            });

            res.status(201).json({
                success: true,
                message: siteId
                    ? 'Employee registered and assigned to the site'
                    : 'Employee registered. Assign a site before they try to check in.',
                data: employee,
            });
        } catch (error:any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async updateEmployee (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid employee id' })

            const validationResult = await updateEmployeeModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { id } = paramResult.data
            const { siteId, ...patch } = validationResult.data

            const existing = await db.query.employees.findFirst({ where: eq(employees.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Employee not found' });
            }

            if (patch.phone && patch.phone !== existing.phone) {
                const clash = await db.query.employees.findFirst({
                    where: eq(employees.phone, patch.phone),
                });
                if (clash) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another employee already uses that phone number',
                    });
                }
            }

            if (patch.email && patch.email !== existing.email) {
                const clash = await db.query.employees.findFirst({
                    where: eq(employees.email, patch.email),
                });
                if (clash) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another employee already uses that email address',
                    });
                }
            }

            if (siteId) {
                const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
                if (!site) {
                    return res.status(404).json({ success: false, message: 'Site not found' });
                }
            }

            const employee = await db.transaction(async (tx) => {
                let row = existing

                if (Object.keys(patch).length) {
                    const [updated] = await tx
                        .update(employees)
                        .set({ ...patch, updatedAt: new Date() })
                        .where(eq(employees.id, id))
                        .returning();
                    if (updated) row = updated
                }

                // undefined leaves the assignment alone; null clears it.
                if (siteId !== undefined) await this.setEmployeeSite(tx, id, siteId)

                return row
            });

            res.json({ success: true, message: 'Employee updated', data: employee });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Delete an employee.
     *
     * Refused once they have attendance history: attendance_logs cascades from
     * employees, so a delete would erase the record of every shift they worked —
     * exactly the data this system exists to keep. Deactivating is the answer,
     * and it also stops the mobile sign-in.
     */
    public async deleteEmployee (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid employee id' })

            const { id } = paramResult.data

            const existing = await db.query.employees.findFirst({ where: eq(employees.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Employee not found' });
            }

            const [logTally] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(attendanceLogs)
                .where(eq(attendanceLogs.employeeId, id))

            const count = logTally?.count ?? 0

            if (count > 0) {
                return res.status(409).json({
                    success: false,
                    message: `${existing.firstName} has ${count} attendance record${count === 1 ? '' : 's'} and cannot be deleted. Deactivate instead — that blocks sign-in and check-ins while keeping the history.`,
                });
            }

            // Site assignments and the login row cascade away with the employee.
            // Both are access, not history, so losing them is correct.
            await db.delete(employees).where(eq(employees.id, id));

            // The row is gone, so nothing points at the photo any more — leaving it
            // on disk would be an orphaned image of someone no longer on the roster.
            await deleteFaceImage(existing.imagePath);

            res.json({ success: true, message: 'Employee deleted' });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async createClientLocation (req: Request, res: Response){
        try {
            const validationResult = await createClientLocationModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { locationName, siteCode, address } = validationResult.data

            const existingLocation =
            await db.query.clientLocations.findFirst({
                where: eq(
                clientLocations.locationName,
                locationName)
            });

            if (existingLocation) {
            res.status(409).json({
                success: false,
                message: 'Location already exists',
            });
            return;
            }

            const [location] = await db
            .insert(clientLocations)
            .values({
                locationName,
                siteCode: siteCode ?? null,
                address: address ?? null,
            })
            .returning();

            res.status(201).json({
            success: true,
            message: 'Location created. Add at least one site to it before assigning employees.',
            data: location,
            });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
            success: false,
            message:
                error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Create a site under a location. The site carries the geofence, so this is
     * the endpoint that decides where an employee may physically punch in.
     */
    public async createSite (req: Request, res: Response){
        try {
            const validationResult = await createSiteModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { locationId, siteName, siteCode, address, latitude, longitude, allowedRadiusMeters } =
                validationResult.data

            const location = await db.query.clientLocations.findFirst({
                where: eq(clientLocations.id, locationId),
            });

            if (!location) {
                res.status(404).json({
                    success: false,
                    message: 'Location not found',
                });
                return;
            }

            // Site names are unique per location, not globally - two clients can
            // each have a "Gate 2". Scope the duplicate check the same way.
            const existingSite = await db.query.sites.findFirst({
                where: and(eq(sites.locationId, locationId), eq(sites.siteName, siteName)),
            });

            if (existingSite) {
                res.status(409).json({
                    success: false,
                    message: 'A site with that name already exists under this location',
                });
                return;
            }

            const [site] = await db
                .insert(sites)
                .values({
                    locationId,
                    siteName,
                    siteCode: siteCode ?? null,
                    address: address ?? null,
                    // numeric columns round-trip as strings in node-postgres, so
                    // the driver wants strings on the way in too.
                    latitude: latitude.toString(),
                    longitude: longitude.toString(),
                    allowedRadiusMeters: allowedRadiusMeters?.toString() ?? '100',
                })
                .returning();

            res.status(201).json({
                success: true,
                message: 'Site created successfully',
                data: { ...site, location: { id: location.id, locationName: location.locationName } },
            });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /** List locations with the number of sites under each. */
    public async listClientLocations (req: Request, res: Response){
        try {
            const rows = await db
                .select({
                    id: clientLocations.id,
                    locationName: clientLocations.locationName,
                    city: clientLocations.city,
                    siteCode: clientLocations.siteCode,
                    address: clientLocations.address,
                    isActive: clientLocations.isActive,
                    createdAt: clientLocations.createdAt,
                    // Left join, not inner: a location with no sites yet must still
                    // appear, otherwise a freshly created one vanishes from the list.
                    siteCount: sql<number>`count(${sites.id})::int`,
                })
                .from(clientLocations)
                .leftJoin(sites, eq(sites.locationId, clientLocations.id))
                .groupBy(clientLocations.id)
                .orderBy(clientLocations.locationName)

            res.json({ success: true, data: { locations: rows } });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async updateClientLocation (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid location id' })

            const validationResult = await updateClientLocationModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { id } = paramResult.data
            const patch = validationResult.data

            const existing = await db.query.clientLocations.findFirst({
                where: eq(clientLocations.id, id),
            });

            if (!existing) {
                return res.status(404).json({ success: false, message: 'Location not found' });
            }

            // The unique index would reject this anyway, but as a 500-looking
            // Postgres error rather than something the form can show on a field.
            if (patch.locationName && patch.locationName !== existing.locationName) {
                const clash = await db.query.clientLocations.findFirst({
                    where: eq(clientLocations.locationName, patch.locationName),
                });
                if (clash) {
                    return res.status(409).json({
                        success: false,
                        message: 'Another location already uses that name',
                    });
                }
            }

            const [location] = await db
                .update(clientLocations)
                .set(patch)
                .where(eq(clientLocations.id, id))
                .returning();

            res.json({ success: true, message: 'Location updated', data: location });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Delete a location.
     *
     * Refused while it still has sites. The foreign key cascades, so allowing it
     * would silently take out every site beneath it — and with them the geofences
     * and employee assignments — from a single click. Deleting the sites first
     * makes that consequence explicit.
     */
    public async deleteClientLocation (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid location id' })

            const { id } = paramResult.data

            const existing = await db.query.clientLocations.findFirst({
                where: eq(clientLocations.id, id),
            });

            if (!existing) {
                return res.status(404).json({ success: false, message: 'Location not found' });
            }

            const [siteTally] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(sites)
                .where(eq(sites.locationId, id))

            const count = siteTally?.count ?? 0

            if (count > 0) {
                return res.status(409).json({
                    success: false,
                    message: `This location still has ${count} site${count === 1 ? '' : 's'}. Delete or move them first, or deactivate the location instead.`,
                });
            }

            await db.delete(clientLocations).where(eq(clientLocations.id, id));

            res.json({ success: true, message: 'Location deleted' });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    public async updateSite (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid site id' })

            const validationResult = await updateSiteModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { id } = paramResult.data
            const { latitude, longitude, allowedRadiusMeters, ...rest } = validationResult.data

            const existing = await db.query.sites.findFirst({ where: eq(sites.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Site not found' });
            }

            const targetLocationId = rest.locationId ?? existing.locationId

            if (rest.locationId && rest.locationId !== existing.locationId) {
                const location = await db.query.clientLocations.findFirst({
                    where: eq(clientLocations.id, rest.locationId),
                });
                if (!location) {
                    return res.status(404).json({ success: false, message: 'Location not found' });
                }
            }

            // Names are unique per location, so both a rename and a re-parent can
            // collide — check against whichever location the site will end up in.
            const nextName = rest.siteName ?? existing.siteName
            if (nextName !== existing.siteName || targetLocationId !== existing.locationId) {
                const clash = await db.query.sites.findFirst({
                    where: and(eq(sites.locationId, targetLocationId), eq(sites.siteName, nextName)),
                });
                if (clash && clash.id !== id) {
                    return res.status(409).json({
                        success: false,
                        message: 'A site with that name already exists under this location',
                    });
                }
            }

            const [site] = await db
                .update(sites)
                .set({
                    ...rest,
                    // Only touch the numeric columns when they were actually sent —
                    // spreading `undefined` into .set() would be a no-op, but
                    // `null` would wipe a NOT NULL column.
                    ...(latitude !== undefined ? { latitude: latitude.toString() } : {}),
                    ...(longitude !== undefined ? { longitude: longitude.toString() } : {}),
                    ...(allowedRadiusMeters !== undefined
                        ? { allowedRadiusMeters: allowedRadiusMeters.toString() }
                        : {}),
                })
                .where(eq(sites.id, id))
                .returning();

            res.json({ success: true, message: 'Site updated', data: site });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Delete a site.
     *
     * Refused once attendance has been logged against it: attendance_logs.site_id
     * is ON DELETE NO ACTION, so the delete would fail on the constraint anyway —
     * this turns that into a 409 that says what to do instead. Employee
     * assignments cascade away, which is correct; they are authorisations, not
     * history.
     */
    public async deleteSite (req: Request, res: Response){
        try {
            const paramResult = idParamModel.safeParse(req.params);
            if (paramResult.error) return res.status(400).json({ success: false, message: 'invalid site id' })

            const { id } = paramResult.data

            const existing = await db.query.sites.findFirst({ where: eq(sites.id, id) });
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Site not found' });
            }

            const [logTally] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(attendanceLogs)
                .where(eq(attendanceLogs.siteId, id))

            const count = logTally?.count ?? 0

            if (count > 0) {
                return res.status(409).json({
                    success: false,
                    message: `This site has ${count} attendance record${count === 1 ? '' : 's'} against it and cannot be deleted. Deactivate it instead — that stops new check-ins and keeps the history.`,
                });
            }

            await db.delete(sites).where(eq(sites.id, id));

            res.json({ success: true, message: 'Site deleted' });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /** List sites, optionally narrowed to one location. */
    public async listSites (req: Request, res: Response){
        try {
            const locationId = req.query.locationId as string | undefined

            const rows = await db
                .select({
                    id: sites.id,
                    siteName: sites.siteName,
                    siteCode: sites.siteCode,
                    address: sites.address,
                    latitude: sites.latitude,
                    longitude: sites.longitude,
                    allowedRadiusMeters: sites.allowedRadiusMeters,
                    isActive: sites.isActive,
                    locationId: clientLocations.id,
                    locationName: clientLocations.locationName,
                })
                .from(sites)
                .innerJoin(clientLocations, eq(sites.locationId, clientLocations.id))
                .where(locationId ? eq(sites.locationId, locationId) : undefined)

            res.json({ success: true, data: { sites: rows } });
        } catch (error: any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message: error.message || 'Internal Server Error',
            });
        }
    }

    /**
     * Authorise an employee to check in at one site.
     *
     * Assignment is per-site rather than per-location on purpose: being posted to
     * a client's head office should not authorise a punch at their warehouse
     * across town.
     */
    public async assignSiteToEmployee (req: Request, res: Response){
        try {
            const validationResult = await assignSiteModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

            const { employeeId, siteId } = validationResult.data;

            const employee = await db.query.employees.findFirst({
                where: eq(employees.id, employeeId),
            });

            if (!employee) {
                res.status(404).json({
                    success: false,
                    message: 'Employee not found',
                });
                return;
            }

            const site = await db.query.sites.findFirst({
                where: eq(sites.id, siteId),
            });

            if (!site) {
                res.status(404).json({
                    success: false,
                    message: 'Site not found',
                });
                return;
            }

            const existing = await db.query.employeeSites.findFirst({
                where: and(
                    eq(employeeSites.employeeId, employeeId),
                    eq(employeeSites.siteId, siteId)
                ),
            });

            if (existing) {
                res.status(409).json({
                    success: false,
                    message: 'Site already assigned to employee',
                });
                return;
            }

            const [assignment] = await db
                .insert(employeeSites)
                .values({ employeeId, siteId })
                .returning();

            res.status(201).json({
                success: true,
                message: 'Site assigned successfully',
                data: assignment,
            });
        } catch (error:any) {
            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    error.message ||
                    'Internal Server Error',
            });
        }
    }

    /**
     * Replace an employee's roles in the users table.
     *
     * The `employee` role is mandatory — it is the gate for check-in/out and
     * must always be present. The client enforces this in the UI; we enforce it
     * here so a direct API call cannot strip it.
     */
    public async updateEmployeeRoles(req: Request, res: Response) {
        try {
            const paramResult = idParamModel.safeParse(req.params)
            if (paramResult.error)
                return res.status(400).json({ success: false, message: 'invalid employee id' })

            const bodyResult = updateEmployeeRolesModel.safeParse(req.body)
            if (bodyResult.error)
                return res.status(400).json({ message: 'body validation failed', error: bodyResult.error.issues })

            const { id } = paramResult.data
            const { roles } = bodyResult.data

            const existing = await db.query.employees.findFirst({ where: eq(employees.id, id) })
            if (!existing)
                return res.status(404).json({ success: false, message: 'Employee not found' })

            const updated = await db
                .update(usersTable)
                .set({ roles })
                .where(eq(usersTable.employeeId, id))
                .returning({ id: usersTable.id, roles: usersTable.roles })

            if (!updated.length)
                return res.status(404).json({
                    success: false,
                    message: 'This employee has no login account yet — they must sign in at least once before roles can be assigned.',
                })

            return res.json({ success: true, message: 'Roles updated', data: { roles: updated[0]!.roles } })
        } catch (error: any) {
            console.error('[update-roles]', error)
            return res.status(500).json({ success: false, message: error.message || 'Internal Server Error' })
        }
    }

}
/** One row of the daily attendance summary — a single employee's day. */
interface DailyReportRow {
    id: string
    employeeName: string
    siteName: string | null
    createdAtDateOnly: string
    checkIn: string | null
    checkOut: string | null
    dutyTime: string | null
    distanceM: number | null
    [key: string]: unknown
}

export default EmployeesController