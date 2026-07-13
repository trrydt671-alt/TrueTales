import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let url = process.env.DATABASE_URL;
if (!url) {
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  url = 'file:' + path.join(dir, 'books.db');
}

export const db = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      extra_context TEXT,
      tones TEXT,
      length TEXT,
      content TEXT NOT NULL,
      cover_mime TEXT,
      cover_data TEXT,
      sources TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
