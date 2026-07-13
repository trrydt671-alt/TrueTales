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
      reading_level TEXT,
      story_form TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Migration for databases created before Update 2 (old books keep working;
  // their new columns are simply NULL).
  for (const col of ['reading_level', 'story_form']) {
    try {
      await db.execute(`ALTER TABLE books ADD COLUMN ${col} TEXT`);
    } catch {
      /* column already exists */
    }
  }
}
