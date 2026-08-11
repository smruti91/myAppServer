import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * Persists report files submitted by `report_collector` employees.
 *
 * Mirrors the shape of faceImageStore, but stores arbitrary document types
 * (PDF, Excel, CSV, Word) rather than images, and uses a flat `reports/`
 * sub-directory so the two upload categories never collide.
 *
 * Files live outside the database: a 10 MB PDF in a column bloats every row
 * that touches the report_submissions table, and Postgres can't stream it.
 */

const UPLOAD_ROOT = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')
const REPORT_DIR  = path.join(UPLOAD_ROOT, 'reports')

// 50 MB cap — daily reports are typically PDF/Excel/CSV, not video.
const MAX_BYTES = 50 * 1024 * 1024

// Extensions we accept. Anything else is stored as 'bin' so a download still
// works, but will lack the correct MIME type — a client that sends garbage is
// unusual enough that we just store it rather than reject mid-submission.
const KNOWN_EXT: Record<string, string> = {
  pdf:  'pdf',
  xlsx: 'xlsx',
  xls:  'xls',
  docx: 'docx',
  doc:  'doc',
  csv:  'csv',
}

function safeExt(originalName: string | undefined): string {
  if (!originalName) return 'bin'
  const ext = path.extname(originalName).replace('.', '').toLowerCase()
  return KNOWN_EXT[ext] ?? 'bin'
}

/**
 * Writes the report buffer and returns the path stored in `report_submissions.file_path`.
 *
 * The path is relative to UPLOAD_ROOT so the server can be moved or the
 * UPLOAD_DIR env var overridden without invalidating stored paths.
 * Throws if the buffer is empty or exceeds the size cap.
 */
export async function saveReportFile(
  employeeId:   string,
  buffer:       Buffer,
  originalName?: string,
): Promise<string> {
  if (buffer.length === 0)        throw new Error('Report file is empty')
  if (buffer.length > MAX_BYTES)  throw new Error(`Report exceeds ${MAX_BYTES / 1024 / 1024} MB limit`)

  await mkdir(REPORT_DIR, { recursive: true })

  const ext      = safeExt(originalName)
  const fileName = `${employeeId}-${randomBytes(8).toString('hex')}.${ext}`
  await writeFile(path.join(REPORT_DIR, fileName), buffer)

  // Relative path — easy to reconstruct the absolute path on any host.
  return `reports/${fileName}`
}

/**
 * Removes a previously stored report — if a submission is ever retracted.
 * Best-effort: a missing file is the desired end state anyway.
 */
export async function deleteReportFile(filePath: string | null | undefined): Promise<void> {
  if (!filePath || !filePath.startsWith('reports/')) return
  const fileName = path.basename(filePath)
  try {
    await unlink(path.join(REPORT_DIR, fileName))
  } catch {
    // Already gone.
  }
}

export { UPLOAD_ROOT as REPORT_UPLOAD_ROOT }
