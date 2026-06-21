import fetch from 'node-fetch';
import FormData from 'form-data';
import { Router } from 'express';

const router = Router();

const PYTHON_SIDECAR = process.env.INSIGHTFACE_URL ?? 'http://localhost:5000';

export async function getEmbeddingFromSidecar(base64Image: string): Promise<number[]> {
  // Strip data-uri prefix if present
  const raw = base64Image.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(raw, 'base64');
 
  // Python FastAPI expects multipart/form-data with a file field
  const form = new FormData();
  form.append('file', imageBuffer, {
    filename: 'face.jpg',
    contentType: 'image/jpeg',
  });
 
  const response = await fetch(`${PYTHON_SIDECAR}/embedding`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    // Timeout after 10s — InsightFace first-run loads model weights
    signal: AbortSignal.timeout(10_000),
  });
 
  if (!response.ok) {
    throw new Error(`Sidecar responded ${response.status}: ${await response.text()}`);
  }
 
  const result = await response.json() as {
    success: boolean;
    embedding?: number[];
    message?: string;
  };
 
  if (!result.success || !result.embedding) {
    throw new Object({ noFace: true, message: result.message ?? 'No face detected' });
  }
 
  return result.embedding; // 512 floats
}