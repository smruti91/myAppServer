import express from 'express'
import type { Router } from 'express'
import multer from 'multer'

import AuthenticationController from './controller'
import { restrictToAuthenticatedUser } from '../middleware/auth-middleware'

const authenticationController = new AuthenticationController()

// Multer in-memory storage — we only need the buffer to convert to base64.
// 8 MB limit covers even large front-camera JPEGs.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
})

export const authRouter: Router = express.Router()

// authRouter.post('/sign-up', authenticationController.handleSignup.bind(authenticationController))
authRouter.post('/sign-in', authenticationController.handleSignin.bind(authenticationController))
authRouter.post('/register-phone', authenticationController.registerByPhone.bind(authenticationController))

// ── Face routes ──────────────────────────────────────────────────────────────
// Both require a valid bearer token. Multer parses the multipart "image" field,
// then the controller converts it to base64 and runs face-api on it.
authRouter.post(
    '/register-face',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleRegisterFace.bind(authenticationController)
)

// Attendance is mounted under auth so the mobile app can reach it at the same base URL.
authRouter.post(
    '/attendance/mark',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleMarkAttendance.bind(authenticationController)
)

authRouter.get(
    '/attendance/history',
    restrictToAuthenticatedUser(),
    authenticationController.handleAttendanceHistory.bind(authenticationController)
)

authRouter.get('/me', restrictToAuthenticatedUser(), authenticationController.handleMe.bind(authenticationController))