import fetch from 'node-fetch';
import FormData from 'form-data';
import { Router } from 'express';

const router = Router();

/**
 * Face-service pool.
 *
 * The sidecar is CPU-only and a single process serves roughly 1-3 punches/sec,
 * so one instance cannot absorb the morning rush. This module:
 *
 *  1. round-robins requests across `INSIGHTFACE_URLS` (comma-separated), so you
 *     can run several sidecar replicas/workers and use every one of them;
 *  2. remembers instances that just failed and skips them for a short cooldown,
 *     so a hung worker does not burn the request timeout on every attempt;
 *  3. caps how many inferences are in flight at once (`FACE_MAX_INFLIGHT`) with
 *     a short wait, so a spike of punches degrades into a readable "busy" error
 *     instead of oversubscribing the cores and timing everything out.
 *
 * The calling code keeps the same signature: `getEmbeddingFromSidecar(base64)`.
 */
const SIDECAR_URLS = (
    process.env.INSIGHTFACE_URLS ??
    process.env.INSIGHTFACE_URL ??
    'http://localhost:5000'
)
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

const COOLDOWN_MS = Number(process.env.FACE_COOLDOWN_MS ?? 30_000);
const MAX_INFLIGHT = Number(process.env.FACE_MAX_INFLIGHT ?? 64);
const QUEUE_WAIT_MS = Number(process.env.FACE_QUEUE_WAIT_MS ?? 5000);
const REQUEST_TIMEOUT_MS = Number(process.env.FACE_TIMEOUT_MS ?? 10_000);

/** instance -> epoch ms until it is tried again. */
const downUntil = new Map<string, number>();
let inFlight = 0;
let cursor = 0;

async function acquireSlot(): Promise<() => void> {
    const deadline = Date.now() + QUEUE_WAIT_MS;
    while (inFlight >= MAX_INFLIGHT) {
        if (Date.now() >= deadline) {
            throw new Error(
                `Face service overloaded (${inFlight} inferences in flight)`
            );
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    inFlight += 1;
    return () => {
        inFlight -= 1;
    };
}

function nextUrl(): string {
    const now = Date.now();
    const healthy = SIDECAR_URLS.filter((u) => (downUntil.get(u) ?? 0) <= now);
    const pool = healthy.length ? healthy : SIDECAR_URLS;
    if (pool.length === 0) {
        throw new Error('No face-service instance configured (INSIGHTFACE_URLS empty)');
    }
    const url = pool[cursor % pool.length];
    cursor += 1;
    return url!;
}

export async function getEmbeddingFromSidecar(base64Image: string): Promise<number[]> {
    // Strip data-uri prefix if present
    const raw = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(raw, 'base64');

    const release = await acquireSlot();
    try {
        let lastErr: unknown = null;

        // Retry across the pool: one crashed or hung instance must not fail the
        // punch, but a "no face" verdict is a business answer, not an
        // infrastructure fault, so it is returned immediately rather than retried.
        for (let attempt = 0; attempt < SIDECAR_URLS.length; attempt++) {
            const url = nextUrl();
            try {
                // Python FastAPI expects multipart/form-data with a file field
                const form = new FormData();
                form.append('file', imageBuffer, {
                    filename: 'face.jpg',
                    contentType: 'image/jpeg',
                });

                const response = await fetch(`${url}/embedding`, {
                    method: 'POST',
                    body: form,
                    headers: form.getHeaders(),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });

                if (!response.ok) {
                    throw new Error(
                        `Sidecar responded ${response.status}: ${await response.text()}`
                    );
                }

                const result = (await response.json()) as {
                    success?: boolean;
                    embedding?: number[];
                    message?: string;
                };

                if (!result.success || !result.embedding) {
                    throw Object.assign(
                        new Error(result.message ?? 'No face detected'),
                        { noFace: true }
                    );
                }

                return result.embedding; // 512 floats
            } catch (err: any) {
                if (err?.noFace) throw err;
                lastErr = err;
                downUntil.set(url, Date.now() + COOLDOWN_MS);
            }
        }

        throw lastErr ?? new Error('All face-service instances failed');
    } finally {
        release();
    }
}

export default router;
