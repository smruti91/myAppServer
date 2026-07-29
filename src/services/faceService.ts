/**
 * faceService.ts (HTTP client)
 *
 * This module no longer runs ML locally. Instead, it forwards every face
 * image to the Python FastAPI service in `../face-service` (built on
 * InsightFace + ONNX Runtime, which is fast and accurate on CPU).
 *
 * The FastAPI service is exposed via docker-compose on:
 *   http://face-service:5000   (inside the docker network)
 *   http://localhost:5000      (from the host)
 *
 * Endpoints used:
 *   GET  /health            → { status: 'ok' }
 *   POST /embedding         → { success, embedding: number[512] }   (register)
 *   POST /verify            → { success, distance, verified }        (check-in/out)
 *
 * Why the split?
 *   - InsightFace's buffalo_l model is ~300MB and depends on onnxruntime
 *     + numpy + opencv. Building that natively on Node.js (especially on
 *     Windows + Node 24) is painful.
 *   - Python already has wheels for everything.
 *   - The FastAPI service runs as its own docker container, scaling
 *     independently of the Node auth server.
 */

const FACE_API_URL = process.env.FACE_API_URL ?? 'http://localhost:5000';

/** Verify threshold: same person → distance ≤ 0.40 (InsightFace cosine) */
export const MATCH_THRESHOLD = 0.40;

/** Health check — useful at server boot */
export async function pingFaceService(): Promise<boolean> {
    try {
        const res = await fetch(`${FACE_API_URL}/health`);
        const data: any = await res.json();
        return data?.status === 'ok';
    } catch (err) {
        console.error('[face] ping failed:', err);
        return false;
    }
}

/**
 * Convert a base64-encoded image (with or without data:image/jpeg;base64, prefix)
 * into a Blob that the fetch multipart upload can stream.
 */
function base64ToBlob(base64: string): Blob {
    const cleaned = base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const bin = Buffer.from(cleaned, 'base64');
    return new Blob([bin], { type: 'image/jpeg' });
}

/**
 * Extract a 512-dim embedding for a face image.
 * Returns null if no face is detected.
 */
export async function extractEmbedding(base64: string): Promise<number[] | null> {
    const form = new FormData();
    form.append('file', base64ToBlob(base64), 'face.jpg');

    const res = await fetch(`${FACE_API_URL}/embedding`, {
        method: 'POST',
        body: form,
    });

    if (!res.ok) {
        throw new Error(`face-service /embedding ${res.status}`);
    }
    const data: any = await res.json();
    if (!data.success) return null;
    if (!Array.isArray(data.embedding)) {
        throw new Error('face-service returned non-array embedding');
    }
    return data.embedding as number[];
}

export interface VerifyResult {
    /** false when the service could not process the image at all (e.g. no face) */
    success: boolean;
    verified: boolean;
    /** cosine distance; 1 (max) when no comparison could be made */
    distance: number;
    message: string;
}

/**
 * Server-side verify: ask the face service to compare a live image against
 * a stored embedding and return distance + threshold-based decision.
 *
 * This single call does detection *and* comparison, so callers do NOT need to
 * run extractEmbedding() first — doing both would run InsightFace twice over
 * the same image and roughly double the request latency on CPU.
 */
export async function verifyFace(
    base64: string,
    storedEmbedding: number[],
    threshold: number = MATCH_THRESHOLD
): Promise<VerifyResult> {
    const form = new FormData();
    form.append('file', base64ToBlob(base64), 'face.jpg');
    form.append('stored_embedding', JSON.stringify(storedEmbedding));
    form.append('threshold', String(threshold));

    const res = await fetch(`${FACE_API_URL}/verify`, {
        method: 'POST',
        body: form,
    });

    if (!res.ok) {
        throw new Error(`face-service /verify ${res.status}`);
    }
    const data: any = await res.json();
    return {
        success: data.success === true,
        verified: data.verified === true,
        distance: typeof data.distance === 'number' ? data.distance : 1,
        message: typeof data.message === 'string' ? data.message : 'unknown face-service response',
    };
}

/** Kept for callers that want to compare locally instead of via /verify */
export function cosineDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error('embedding length mismatch');
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i]!;
        const bv = b[i]!;
        dot += av * bv;
        na  += av * av;
        nb  += bv * bv;
    }
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}