import type { Request, Response } from 'express'
import { db } from '../../db'
import { attendanceLogs, employees, clientLocations, employeeLocations } from '../../db/schema'
import { eq, and, sql } from 'drizzle-orm';

import path from 'path';
import { createEmployeeSchema,createClientLocationModel, assignLocationModel } from './models';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { getEmbeddingFromSidecar } from '../utils/pythonSidecar';
 

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
                // Drizzle customType handles number[] → '[f1,...,f512]' serialisation
                await db
                .update(employees)
                .set({
                    faceEmbedding: embedding,
                    hasRegisteredFace: true,
                    faceRegisteredAt:  new Date(),
                })
                .where(eq(employees.id, empId));
            
                return res.status(200).json({
                message: 'Face registered successfully',
                data: { empId, embeddingDimensions: embedding.length },
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
            const checkinExists = await db
                .select({ id: attendanceLogs.id })
                .from(attendanceLogs)
                .where(and(
                eq(attendanceLogs.employeeId, empId),
                eq(attendanceLogs.action, 'check-in'),
                sql`DATE(${attendanceLogs.createdAt}) = CURRENT_DATE`
                ))
                .limit(1);
        
            if (!checkinExists.length)
                return res.status(409).json({ message: 'Cannot check out without checking in first.' });
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

    public async handleEployeeRegister(req: Request, res: Response){
        try {
            const validationResult = await createEmployeeSchema.safeParseAsync(req.body);

       if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })
       
        const { firstName, lastName, phone, department, designation } = validationResult.data;

          // Check employee code or phone exists
            const existingEmployee = await db.query.employees.findFirst({
            where: (
                eq(employees.phone, phone)
            ),
            });
          if (existingEmployee) {
             if (existingEmployee.phone === phone) {
                    res.status(409).json({
                    success: false,
                    message: 'Phone number already exists',
                    });
                    return;
                }
          }
          
          const [employee] = await db
                        .insert(employees)
                        .values({
                            firstName: firstName,
                            lastName: lastName,
                            phone: phone,
                            department: department,
                            designation: designation,
                            isActive:  true,
                        })
                        .returning();
        res.status(201).json({
            success: true,
            message: 'Employee registered successfully',
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

    public async createClientLocation (req: Request, res: Response){
        try {
             const validationResult = await createClientLocationModel.safeParseAsync(req.body);
            if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

           const { locationName, latitude,longitude, allowedRadiusMeters } = validationResult.data

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
                locationName: locationName,
                latitude: latitude.toString(),
                longitude: longitude.toString(),
                allowedRadiusMeters:
                allowedRadiusMeters?.toString() ??
                '100',
            })
            .returning();

            res.status(201).json({
            success: true,
            message: 'Location created successfully',
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

    public async assignLocationToEmployee (req: Request, res: Response){
        try {
            
        
        const validationResult = await assignLocationModel.safeParseAsync(req.body);
        if (validationResult.error) return res.status(400).json({ message: 'body validation failed', error: validationResult.error.issues })

        const { employeeId, locationId } = validationResult.data;

        // Verify employee exists
        const employee =
        await db.query.employees.findFirst({
            where: eq(
            employees.id,
            employeeId
            ),
        });

        if (!employee) {
        res.status(404).json({
            success: false,
            message: 'Employee not found',
        });
        return;
        }

        // Verify location exists
        const location =
        await db.query.clientLocations.findFirst({
            where: eq(
            clientLocations.id,
            locationId
            ),
        });

        if (!location) {
        res.status(404).json({
            success: false,
            message: 'Location not found',
        });
        return;

    }

    // Check already assigned
    const existing =
      await db.query.employeeLocations.findFirst({
        where: and(
          eq(
            employeeLocations.employeeId,
            employeeId
          ),
          eq(
            employeeLocations.locationId,
            locationId
          )
        ),
      });

    if (existing) {
      res.status(409).json({
        success: false,
        message:
          'Location already assigned to employee',
      });
      return;
    }

    const [assignment] = await db
      .insert(employeeLocations)
      .values({
        employeeId: employeeId,
        locationId: locationId,
      })
      .returning();

    res.status(201).json({
      success: true,
      message:
        'Location assigned successfully',
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
    
}

export default EmployeesController