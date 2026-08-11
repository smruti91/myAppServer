import express from 'express'
import type { Router } from 'express'
import multer from 'multer'

import AuthenticationController from './controller'
import AdminAuthController from './admin-controller'
import { restrictToAuthenticatedUser, restrictToAdmin } from '../middleware/auth-middleware'

const authenticationController = new AuthenticationController()
const adminAuthController = new AdminAuthController()

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

// Current check-in state + whether the minimum-gap rule has released check-out.
// The app calls this on launch so its buttons reflect the server, not whatever
// was in component state when it was last closed.
authRouter.get(
    '/attendance/status',
    restrictToAuthenticatedUser(),
    authenticationController.handleAttendanceStatus.bind(authenticationController)
)

authRouter.get(
    '/attendance/history',
    restrictToAuthenticatedUser(),
    authenticationController.handleAttendanceHistory.bind(authenticationController)
)

authRouter.get('/me', restrictToAuthenticatedUser(), authenticationController.handleMe.bind(authenticationController))

// The employee's assigned sites and their geofences. The app refreshes these on
// launch so an admin's change to a radius or posting takes effect without the
// employee having to sign out and back in.
authRouter.get(
    '/my-sites',
    restrictToAuthenticatedUser(),
    authenticationController.handleMySites.bind(authenticationController)
)

// ── Admin panel auth (web) ───────────────────────────────────────────────────
// sign-in / refresh / sign-out are public: they authenticate via credentials or
// the httpOnly refresh cookie, not via a bearer token. Only /me is guarded.
authRouter.post('/admin/sign-in', adminAuthController.handleSignIn.bind(adminAuthController))
authRouter.post('/admin/refresh', adminAuthController.handleRefresh.bind(adminAuthController))
authRouter.post('/admin/sign-out', adminAuthController.handleSignOut.bind(adminAuthController))
authRouter.get('/admin/me', restrictToAdmin(), adminAuthController.handleMe.bind(adminAuthController))

// ── Supervisor routes ────────────────────────────────────────────────────────
// Role check is enforced inside the handler (403 if the JWT user doesn't have
// the 'supervisor' role), so no separate middleware is needed.

// GET /auth/supervisor/employee-by-phone?phone=09xxxxxxxxx
// Returns name + designation + hasRegisteredFace for the target employee.
authRouter.get(
    '/supervisor/employee-by-phone',
    restrictToAuthenticatedUser(),
    authenticationController.handleEmployeeByPhone.bind(authenticationController)
)

// POST /auth/supervisor/register-face
// Multipart: employeePhone (text) + image (file). Registers the employee's face
// on behalf of the supervisor — no face-check of the supervisor is needed.
authRouter.post(
    '/supervisor/register-face',
    restrictToAuthenticatedUser(),
    upload.single('image'),
    authenticationController.handleSupervisorRegisterFace.bind(authenticationController)
)

// ── Report collector routes ──────────────────────────────────────────────────
// POST /auth/reports/submit
// Multipart: image (face frame) + file (report doc) + lat + lng.
// Verifies the submitter's face before saving the report.
authRouter.post(
    '/reports/submit',
    restrictToAuthenticatedUser(),
    upload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'file',  maxCount: 1 },
    ]),
    authenticationController.handleSubmitReport.bind(authenticationController)
)