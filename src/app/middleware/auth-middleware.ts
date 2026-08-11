import type { Request, Response, NextFunction } from 'express'
import { verifyUserToken } from '../auth/utils/token'

export function authenticationMiddleware() {
    return function (req: Request, res: Response, next: NextFunction) {
        const header = req.headers['authorization']

        // If no authorization header is present, treat request as unauthenticated
        if (!header) return next()

        if (!header?.startsWith('Bearer')) {
            return res.status(400).json({ error: 'authorization header must start with Bearer' })
        }

        const token = header.split(' ')[1]

        if (!token) return res.status(400).json({ error: 'authorization header must start with Bearer and followed by token' })

        let user
        try {
            user = verifyUserToken(token)
        } catch (err) {
            return res.status(401).json({ error: 'invalid or expired token' })
        }

        // @ts-ignore
        req.user = user

        next()
    }
}

export function restrictToAuthenticatedUser() {
    return function (req: Request, res: Response, next: NextFunction) {
        // @ts-ignore
        if (!req.user) return res.status(401).json({ error: 'Authentication Required' })
        return next()
    }
}

/**
 * Admin-only guard.
 *
 * The 401/403 split matters to the web client's axios interceptor: 401 means
 * "token missing or expired, try refreshing", while 403 means "this identity is
 * authenticated but is not an admin" — refreshing would never help, so the
 * interceptor must not retry. An expired access token lands here as
 * `req.user === null` (verifyUserToken returns null) and correctly yields 401.
 */
export function restrictToAdmin() {
    return function (req: Request, res: Response, next: NextFunction) {
        // @ts-ignore — req.user is set by authenticationMiddleware
        const user = req.user as { id: string; role?: string } | null | undefined

        if (!user) {
            return res.status(401).json({ success: false, message: 'Authentication required' })
        }
        if (user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Admin access required' })
        }
        return next()
    }
}