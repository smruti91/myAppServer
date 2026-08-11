import express from 'express'
import type { Express } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'

import { authRouter } from './auth/routes'
import { empRouter } from './employees/routes'
import { authenticationMiddleware } from './middleware/auth-middleware'
import { FACE_UPLOAD_ROOT } from '../services/faceImageStore'

// Origins allowed to send credentials (the admin panel's refresh cookie).
// A wildcard origin is not an option here: browsers refuse to attach credentials
// to `Access-Control-Allow-Origin: *`, so the cookie would silently never be sent.
const WEB_ORIGINS = ('http://localhost:5174, http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

export function createApplication(): Express {
    const app = express()

    // Middlewares
    app.use(
        cors({
            // The mobile app sends no Origin header, so `origin` is undefined there —
            // allow it through, since it authenticates with a bearer token and never
            // relies on cookies.
            origin(origin, callback) {
                if (!origin || WEB_ORIGINS.includes(origin)) return callback(null, true)
                // `false`, not an Error: throwing here reaches the express error
                // handler and answers with a 500, which reads like a server bug in
                // the logs. Omitting the header is the actual CORS mechanism — the
                // browser blocks the response on its own.
                return callback(null, false)
            },
            credentials: true,
        })
    )
    app.use(express.json(
        {
        limit: '50mb'
        }
    ))
    app.use(cookieParser())
    app.use(authenticationMiddleware())


    // Enrolment photos. Mounted before the auth middleware would matter anyway —
    // an <img src> cannot carry the bearer token the panel holds in memory, so a
    // guarded route would simply render as a broken image. The filenames carry a
    // random suffix instead (see services/faceImageStore), so a URL cannot be
    // guessed from an employee id. `immutable` is safe because a re-enrolment
    // writes a new filename rather than overwriting the old one.
    app.use(
        '/uploads',
        express.static(FACE_UPLOAD_ROOT, {
            maxAge: '30d',
            immutable: true,
            // Nothing here is meant to be browsable — a request for a directory
            // should 404 rather than list who is enrolled. Misses fall through to
            // the router and end as a plain 404; `fallthrough: false` would instead
            // push a NotFoundError through finalhandler, printing a stack trace for
            // every stale <img src> a cached page still asks for.
            index: false,
            redirect: false,
        })
    )

    // Routes
    app.get('/', (req, res) => {
        return res.json({ message: 'Welcome to ChaiCode Auth Service' })
    })

    app.use('/auth', authRouter) 
    app.use('/employee', empRouter)


    return app
}
