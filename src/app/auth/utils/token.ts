import JWT from 'jsonwebtoken'
import type jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../../db'
import { refreshTokens } from '../../../db/schema'

export interface UserTokenPayload {
    id: string
    /** 'admin' for admin-panel access tokens; absent on legacy mobile tokens. */
    role?: string
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'myjwtsecret'

/**
 * Admin access tokens are deliberately short-lived — the refresh cookie renews them.
 * Overridable so the refresh path can be exercised without waiting 15 minutes:
 * `ADMIN_ACCESS_TTL=10s npm run dev`.
 */
// Cast because jsonwebtoken types `expiresIn` as a template-literal union
// (`${number}m` | `${number}s` | …), which a plain env string cannot satisfy.
const ADMIN_ACCESS_TTL = (process.env.ADMIN_ACCESS_TTL ?? '15m') as NonNullable<
    jwt.SignOptions['expiresIn']
>
/** Refresh-token lifetime. Rotation issues a fresh one on every use. */
const REFRESH_TTL_DAYS = 7

/**
 * Mobile app token. Intentionally left non-expiring.
 *
 * Adding `expiresIn` here would start expiring every employee's session, and the
 * mobile app has no refresh flow to recover — it would simply stop working mid-shift.
 * Giving mobile real expiry means building refresh on that client too.
 */
export function createUserToken(payload: UserTokenPayload) {
    const token = JWT.sign(payload, JWT_SECRET)
    return token
}

export function verifyUserToken(token: string) {
    try {
        const payload = JWT.verify(token, JWT_SECRET) as UserTokenPayload
        return payload
    } catch (error) {
        return null
    }
}

// ── Admin access tokens ──────────────────────────────────────────────────────

export function createAdminAccessToken(payload: { id: string }) {
    return JWT.sign({ id: payload.id, role: 'admin' }, JWT_SECRET, {
        expiresIn: ADMIN_ACCESS_TTL,
    })
}

// ── Refresh tokens ───────────────────────────────────────────────────────────
// The raw token only ever exists in the httpOnly cookie. The database stores its
// sha256, so reading the table does not hand an attacker a usable token. sha256
// with no salt is the right choice here (unlike for passwords): the input is 256
// bits of entropy, so there is nothing to brute-force, and lookup must be by
// exact hash.

function hashToken(raw: string) {
    return createHash('sha256').update(raw).digest('hex')
}

function expiryFromNow() {
    return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000)
}

/** Mint a refresh token for a user and persist its hash. Returns the raw token. */
export async function issueRefreshToken(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('hex')

    await db.insert(refreshTokens).values({
        userId,
        tokenHash: hashToken(raw),
        expiresAt: expiryFromNow(),
    })

    return raw
}

/**
 * Consume a refresh token and issue its replacement (rotation).
 *
 * Returns null when the token is unknown, already revoked, or expired — all of
 * which the caller should treat identically: clear the cookie and force a login.
 * Revoking before inserting means a replayed token fails on the second use, which
 * is the entire point of rotation.
 */
export async function rotateRefreshToken(
    raw: string
): Promise<{ raw: string; userId: string } | null> {
    if (!raw) return null

    const tokenHash = hashToken(raw)

    const [row] = await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
        .limit(1)

    if (!row) return null
    if (row.expiresAt.getTime() <= Date.now()) return null

    await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, row.id))

    const replacement = await issueRefreshToken(row.userId)
    return { raw: replacement, userId: row.userId }
}

/** Revoke a single refresh token (sign-out). Unknown tokens are a no-op. */
export async function revokeRefreshToken(raw: string): Promise<void> {
    if (!raw) return

    await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, hashToken(raw)), isNull(refreshTokens.revokedAt)))
}
