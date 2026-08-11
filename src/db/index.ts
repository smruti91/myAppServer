import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';

import * as schema from '../db/schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Optional tuning
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
});
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Kolkata'");
});
export const db = drizzle(pool, {
  schema,
});

export async function bootstrapDatabase() {
  try {
    // Enable extensions
    await db.execute(
      sql`CREATE EXTENSION IF NOT EXISTS vector`
    );

    await db.execute(
      sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
    );

    // Face embedding index
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS employees_face_embedding_ivfflat_idx
      ON employees
      USING ivfflat (face_embedding vector_cosine_ops)
      WITH (lists = 100)
    `);

    console.log('[DB] Bootstrap completed');
  } catch (error) {
    console.error('[DB] Bootstrap failed', error);
  }
}