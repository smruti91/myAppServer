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
 *   POST /liveness          → { success, is_real, status, confidence }   (anti-spoofing)
 *   POST /embedding         → { success, embedding: number[512], liveness }   (register)
 *   POST /verify            → { success, distance, verified, liveness }   (check-in/out)
 *
 * Anti-spoofing (MiniFAS, facenox/face-antispoof-onnx):
 *   /embedding and /verify reject spoofed faces (printed photos / screens)
 *   by default. Pass `require_liveness=false` to bypass, or read the
 *   `liveness` field in the response to audit the decision.
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

/** Liveness threshold: real-class probability ≥ 0.50 (MiniFAS) */
export const LIVENESS_THRESHOLD = 0.50;

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

export interface LivenessResult {
    /** false when the service could not classify the image (e.g. no face) */
    success: boolean;
    is_real: boolean;
    status: 'real' | 'spoof' | 'no_face';
    /** |real_logit - spoof_logit|; larger = more confident */
    confidence: number;
    logit_diff: number;
    real_logit: number;
    spoof_logit: number;
    message?: string;
}

/**
 * Anti-spoofing check: does the face in this image look like a live person
 * rather than a printed photo or screen display?
 */
export async function checkLiveness(
    base64: string,
    threshold: number = LIVENESS_THRESHOLD
): Promise<LivenessResult> {
    const form = new FormData();
    form.append('file', base64ToBlob(base64), 'face.jpg');
    form.append('threshold', String(threshold));

    const res = await fetch(`${FACE_API_URL}/liveness`, {
        method: 'POST',
        body: form,
    });

    if (!res.ok) {
        throw new Error(`face-service /liveness ${res.status}`);
    }
    const data: any = await res.json();
    return {
        success: data.success === true,
        is_real: data.is_real === true,
        status: data.status ?? 'no_face',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        logit_diff: typeof data.logit_diff === 'number' ? data.logit_diff : 0,
        real_logit: typeof data.real_logit === 'number' ? data.real_logit : 0,
        spoof_logit: typeof data.spoof_logit === 'number' ? data.spoof_logit : 0,
        message: typeof data.message === 'string' ? data.message : undefined,
    };
}

/**
 * Extract a 512-dim embedding for a face image.
 * Returns null if no face is detected OR the face is classified as a spoof
 * (the service rejects spoofed faces by default).
 */
export async function extractEmbedding(
    base64: string,
    requireLiveness: boolean = true,
    livenessThreshold: number = LIVENESS_THRESHOLD
): Promise<number[] | null> {
    const form = new FormData();
    form.append('file', base64ToBlob(base64), 'face.jpg');
    form.append('require_liveness', String(requireLiveness));
    form.append('threshold', String(livenessThreshold));

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
    /** false when the service could not process the image at all (no face, bad input, or spoof) */
    success: boolean;
    verified: boolean;
    /** cosine distance; 1 (max) when no comparison could be made */
    distance: number;
    message: string;
    /** anti-spoofing verdict for the live image */
    liveness: LivenessResult;
}

/**
 * Server-side verify: ask the face service to compare a live image against
 * a stored embedding and return distance + threshold-based decision.
 *
 * This single call does detection, anti-spoofing *and* comparison, so callers
 * do NOT need to run extractEmbedding() or checkLiveness() first — doing so
 * would run InsightFace twice over the same image and roughly double the
 * request latency on CPU.
 *
 * Spoofed faces are rejected by default: when the image is a printed photo or
 * screen display, the service returns verified=false before any comparison.
 */
export async function verifyFace(
    base64: string,
    storedEmbedding: number[],
    threshold: number = MATCH_THRESHOLD,
    requireLiveness: boolean = true,
    livenessThreshold: number = LIVENESS_THRESHOLD
): Promise<VerifyResult> {
    const form = new FormData();
    form.append('file', base64ToBlob(base64), 'face.jpg');
    form.append('stored_embedding', JSON.stringify(storedEmbedding));
    form.append('threshold', String(threshold));
    form.append('require_liveness', String(requireLiveness));
    form.append('liveness_threshold', String(livenessThreshold));

    const res = await fetch(`${FACE_API_URL}/verify`, {
        method: 'POST',
        body: form,
    });

    if (!res.ok) {
        throw new Error(`face-service /verify ${res.status}`);
    }
    const data: any = await res.json();
    const liveness: LivenessResult = {
        success: data.liveness?.success === true,
        is_real: data.liveness?.is_real === true,
        status: data.liveness?.status ?? 'no_face',
        confidence: typeof data.liveness?.confidence === 'number' ? data.liveness.confidence : 0,
        logit_diff: typeof data.liveness?.logit_diff === 'number' ? data.liveness.logit_diff : 0,
        real_logit: typeof data.liveness?.real_logit === 'number' ? data.liveness.real_logit : 0,
        spoof_logit: typeof data.liveness?.spoof_logit === 'number' ? data.liveness.spoof_logit : 0,
    };
    return {
        success: data.success === true,
        verified: data.verified === true,
        distance: typeof data.distance === 'number' ? data.distance : 1,
        message: typeof data.message === 'string' ? data.message : 'unknown face-service response',
        liveness,
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
