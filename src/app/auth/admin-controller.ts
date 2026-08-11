/**
 * Admin authentication for the web panel (`lks/`).
 *
 * Kept separate from AuthenticationController because the mobile sign-in flow
 * resolves an employee record via `usersTable.employeeId`, which is null for an
 * admin. Sharing that handler would send admins down a "Employee not found" path.
 *
 * Token model:
 *   - short-lived access JWT (15m) returned in the response body, held in memory
 *     by the browser — never in localStorage, so XSS cannot exfiltrate it
 *   - long-lived refresh token in an httpOnly cookie, rotated on every use
 *
 * Because the access token lives only in memory, a page reload has no token; the
 * client bootstraps by calling /refresh, which is why that route must work from a
 * cold load with nothing but the cookie.
 */

import type { Request, Response, CookieOptions } from 'express'
import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { usersTable } from '../../db/schema'
import { adminSignInModel } from './models'
import {
    createAdminAccessToken,
    issueRefreshToken,
    rotateRefreshToken,
    revokeRefreshToken,
} from './utils/token'

export const REFRESH_COOKIE = 'lks_admin_refresh'

/**
 * Scoped to /auth/admin so the cookie is not attached to unrelated requests.
 * sameSite 'lax' is enough for a same-site SPA and still blocks cross-site POSTs.
 * `secure` only in production — it would break plain-http localhost development.
 */
function refreshCookieOptions(): CookieOptions {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/auth/admin',
        maxAge: 7 * 24 * 60 * 60 * 1000,
    }
}

function hashPassword(password: string, salt: string) {
    // Same construction as the existing employee auth, so one password scheme
    // covers the whole users table.
    return createHmac('sha256', salt).update(password).digest('hex')
}

class AdminAuthController {
    public async handleSignIn(req: Request, res: Response) {
        try {
            const validationResult = await adminSignInModel.safeParseAsync(req.body)
            if (validationResult.error) {
                return res.status(400).json({
                    success: false,
                    message: 'body validation failed',
                    error: validationResult.error.issues,
                })
            }

            const { phone, password } = validationResult.data

            const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone))

            // Same response for "no such user" and "wrong password" so the endpoint
            // cannot be used to enumerate which phone numbers have accounts.
            const invalid = () =>
                res.status(401).json({ success: false, message: 'Invalid phone number or password' })

            if (!user || !user.salt || !user.password) return invalid()
            if (hashPassword(password, user.salt) !== user.password) return invalid()

            if (user.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'This account does not have admin access',
                })
            }
            if (!user.isActive) {
                return res.status(403).json({ success: false, message: 'This account is disabled' })
            }

            const accessToken = createAdminAccessToken({ id: user.id })
            const refresh = await issueRefreshToken(user.id)

            res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions())

            return res.json({
                success: true,
                message: 'Signed in successfully',
                data: {
                    accessToken,
                    admin: { id: user.id, phone: user.phone, role: user.role },
                },
            })
        } catch (err: any) {
            console.error('[admin/sign-in]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    /**
     * Exchange the refresh cookie for a new access token, rotating the refresh
     * token in the process. Doubles as the client's session-bootstrap call on load.
     */
    public async handleRefresh(req: Request, res: Response) {
        try {
            const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined

            const rejected = () => {
                // Clear the cookie so a stale value stops being retried on every load.
                res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined })
                return res
                    .status(401)
                    .json({ success: false, message: 'Session expired. Please sign in again.' })
            }

            if (!presented) return rejected()

            const rotated = await rotateRefreshToken(presented)
            if (!rotated) return rejected()

            // Confirm the account is still an active admin — a demotion or
            // deactivation must end the session rather than ride on an old token.
            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, rotated.userId))
            if (!user || user.role !== 'admin' || !user.isActive) {
                await revokeRefreshToken(rotated.raw)
                return rejected()
            }

            res.cookie(REFRESH_COOKIE, rotated.raw, refreshCookieOptions())

            return res.json({
                success: true,
                data: {
                    accessToken: createAdminAccessToken({ id: user.id }),
                    admin: { id: user.id, phone: user.phone, role: user.role },
                },
            })
        } catch (err: any) {
            console.error('[admin/refresh]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handleSignOut(req: Request, res: Response) {
        try {
            const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined
            if (presented) await revokeRefreshToken(presented)

            res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined })
            return res.json({ success: true, message: 'Signed out' })
        } catch (err: any) {
            console.error('[admin/sign-out]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }

    public async handleMe(req: Request, res: Response) {
        try {
            // @ts-ignore — set by authenticationMiddleware, role-checked by restrictToAdmin
            const userId = req.user?.id as string

            const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId))
            if (!user) return res.status(404).json({ success: false, message: 'Admin not found' })

            return res.json({
                success: true,
                data: { admin: { id: user.id, phone: user.phone, role: user.role } },
            })
        } catch (err: any) {
            console.error('[admin/me]', err)
            return res.status(500).json({ success: false, message: err.message })
        }
    }
}

export default AdminAuthController
