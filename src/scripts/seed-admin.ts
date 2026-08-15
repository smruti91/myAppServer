/**
 * Create (or promote) an admin account for the web panel.
 *
 *   npx tsx src/scripts/seed-admin.ts <phone> <password>
 *   ADMIN_PHONE=9000000001 ADMIN_PASSWORD=secret npx tsx src/scripts/seed-admin.ts
 *
 * Credentials come from argv/env so none are committed. Admin rows have
 * employeeId = null — they are not employees, which is why that column had to
 * become nullable.
 *
 * Re-running with an existing phone promotes that user to admin and resets its
 * password, so this doubles as a password-reset escape hatch.
 */

import 'dotenv/config'
import { randomBytes, createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { usersTable } from '../db/schema'

async function main() {
    const phone = process.argv[2] ?? process.env.ADMIN_PHONE
    const password = process.argv[3] ?? process.env.ADMIN_PASSWORD

    if (!phone || !password) {
        console.error(
            'Usage: npx tsx src/scripts/seed-admin.ts <phone> <password>\n' +
                '   or: set ADMIN_PHONE and ADMIN_PASSWORD in the environment'
        )
        process.exit(1)
    }
    if (password.length < 5) {
        console.error('Password must be at least 5 characters (adminSignInModel requires it).')
        process.exit(1)
    }
    if (phone.length < 10 || phone.length > 15) {
        console.error('Phone must be 10–15 characters.')
        process.exit(1)
    }

    // Same salted-HMAC scheme as the employee auth path, so one verification
    // routine serves every row in the users table.
    const salt = randomBytes(32).toString('hex')
    const hash = createHmac('sha256', salt).update(password).digest('hex')

    const [existing] = await db.select().from(usersTable).where(eq(usersTable.phone, phone))

    if (existing) {
        await db
            .update(usersTable)
            .set({ role: 'admin', password: hash, salt, isActive: true })
            .where(eq(usersTable.id, existing.id))

        console.log(`Promoted existing user ${phone} to admin and reset its password.`)
        console.log(`  id: ${existing.id}`)
        if (existing.employeeId) {
            console.log('  note: this user is also linked to an employee record.')
            console.log('  it can no longer sign in on the mobile app — admins are web-only.')
        }
    } else {
        const [created] = await db
            .insert(usersTable)
            .values({ phone, password: hash, salt, role: 'admin', employeeId: null })
            .returning({ id: usersTable.id })

        console.log(`Created admin ${phone}.`)
        console.log(`  id: ${created?.id}`)
    }

    console.log('\nSign in at the admin panel with this phone number and password.')
    process.exit(0)
}

main().catch((err) => {
    console.error('seed-admin failed:', err)
    process.exit(1)
})
