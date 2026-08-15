import { randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Persists the JPEG captured during face registration.
 *
 * The embedding alone is not reviewable: it is 512 floats, and an admin looking
 * at the roster cannot tell from it whether the right person enrolled, or
 * whether the frame was a blurry ceiling shot. Keeping the source image makes
 * enrolment auditable — and gives the panel an avatar to show.
 *
 * Files live outside the database on purpose. A base64 photo in a column bloats
 * every row read that does `select *`, and Postgres has no way to stream it.
 */

// Resolved from cwd (the server is started from `server/`) so the same code path
// works whether it runs from `src/` under tsx or from `dist/` after a build —
// __dirname would point at two different depths.
const UPLOAD_ROOT = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')
const FACE_DIR = path.join(UPLOAD_ROOT, 'faces')

/** Public prefix — matches the express.static mount in app/index.ts. */
const PUBLIC_PREFIX = '/uploads/faces'

// The capture side downscales to ~1280x960, which lands around 400 KB. 8 MB is
// far above anything the app can legitimately send, so anything larger is a
// client bug or someone probing — cheaper to reject than to write to disk.
const MAX_BYTES = 8 * 1024 * 1024

/** Magic-byte sniff. The extension has to describe the actual bytes, not the caller's claim. */
function extensionFor(buffer: Buffer): string | null {
    if (buffer.length < 4) return null
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
    return null
}

/**
 * Writes a face image and returns the path to store in `employees.image_path`.
 *
 * The filename carries a random suffix rather than being just the employee id:
 * the directory is served statically, and a guessable URL would let anyone who
 * knows an id pull a colleague's photograph. The suffix also sidesteps browser
 * caching — a re-enrolment gets a new URL, so the panel never shows the old face.
 *
 * Returns null when the payload is not a decodable image; the caller decides
 * whether that is fatal. Registration itself is not — the embedding is what
 * attendance actually runs on.
 */
export async function saveFaceImage(employeeId: string, base64: string): Promise<string | null> {
    // A data: prefix should have been stripped client-side, but a stray one here
    // would decode to garbage and silently write an unopenable file.
    const raw = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    const buffer = Buffer.from(raw, 'base64')

    if (buffer.length === 0 || buffer.length > MAX_BYTES) return null

    const ext = extensionFor(buffer)
    if (!ext) return null

    await mkdir(FACE_DIR, { recursive: true })

    const fileName = `${employeeId}-${randomBytes(8).toString('hex')}.${ext}`
    await writeFile(path.join(FACE_DIR, fileName), buffer)

    return `${PUBLIC_PREFIX}/${fileName}`
}

/**
 * Removes a previously stored image — on re-enrolment, and when an employee is
 * deleted. Best-effort: a missing file is the desired end state anyway, and a
 * failure here must never turn a successful registration into a 500.
 */
export async function deleteFaceImage(publicPath: string | null | undefined): Promise<void> {
    if (!publicPath || !publicPath.startsWith(`${PUBLIC_PREFIX}/`)) return

    // Only the basename is used, so a stored value containing `../` cannot walk
    // out of the faces directory even if one ever got written.
    const fileName = path.basename(publicPath)
    try {
        await unlink(path.join(FACE_DIR, fileName))
    } catch {
        // Already gone, or never written. Nothing to do.
    }
}

export const FACE_UPLOAD_ROOT = UPLOAD_ROOT
