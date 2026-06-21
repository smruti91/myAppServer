import express from 'express'
import type { Express } from 'express'
import cors from 'cors'

import { authRouter } from './auth/routes'
import { empRouter } from './employees/routes'
import { authenticationMiddleware } from './middleware/auth-middleware'


export function createApplication(): Express {
    const app = express()

    // Middlewares
    app.use(cors())
    app.use(express.json(
        {
        limit: '50mb'
        }
    ))
    app.use(authenticationMiddleware())

     
    // Routes
    app.get('/', (req, res) => {
        return res.json({ message: 'Welcome to ChaiCode Auth Service' })
    })

    app.use('/auth', authRouter)
    app.use('/employee', empRouter)


    return app
}