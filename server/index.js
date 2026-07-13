import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny .env loader (no dependency needed)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { default: express } = await import('express');
const { db, initDb } = await import('./db.js');
const { startGeneration, getJob, requiredKeyError, READING_LEVELS, STORY_FORMS } = await import('./generate.js');

await initDb();
const app = express();
app.use(express.json({ limit: '2mb' }));

const rowToSummary = (r) => ({
  id: r.id,
  title: r.title,
  subject: r.subject,
  tones: JSON.parse(r.tones || '[]'),
  length: r.book_length,
  reading_level: r.reading_level || 'default',
  story_form: r.story_form || 'default',
  created_at: r.created_at,
  updated_at: r.updated_at,
  cover_url: `/api/books/${r.id}/cover?v=${encodeURIComponent(r.updated_at)}`,
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- Generation ---
app.post('/api/books/generate', (req, res) => {
  const { subject, extraContext, length, tones, readingLevel, storyForm } = req.body || {};
  if (!subject || !String(subject).trim()) {
    return res.status(400).json({ error: 'subject is required' });
  }
  const keyErr = requiredKeyError();
  if (keyErr) {
    return res.status(500).json({ error: keyErr });
  }
  const jobId = startGeneration({
    subject: String(subject).trim(),
    extraContext: String(extraContext || '').trim(),
    length: ['short', 'medium', 'long'].includes(length) ? length : 'medium',
    tones: Array.isArray(tones) ? tones.slice(0, 6) : [],
    readingLevel: readingLevel in READING_LEVELS ? readingLevel : 'default',
    storyForm: storyForm in STORY_FORMS ? storyForm : 'default',
  });
  res.status(202).json({ jobId });
});

app.get('/api/generate/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found (server may have restarted)' });
  res.json({ status: job.status, bookId: job.bookId, error: job.error });
});

// --- Books CRUD ---
app.get('/api/books', async (_req, res) => {
  const { rows } = await db.execute(
    'SELECT id, title, subject, tones, length AS book_length, reading_level, story_form, created_at, updated_at FROM books ORDER BY created_at DESC'
  );
  res.json(rows.map(rowToSummary));
});

app.get('/api/books/:id', async (req, res) => {
  const { rows } = await db.execute({
    sql: 'SELECT id, title, subject, extra_context, tones, length AS book_length, content, sources, reading_level, story_form, created_at, updated_at FROM books WHERE id = ?',
    args: [req.params.id],
  });
  if (!rows.length) return res.status(404).json({ error: 'Book not found' });
  const r = rows[0];
  res.json({
    ...rowToSummary(r),
    extra_context: r.extra_context,
    content: r.content,
    sources: JSON.parse(r.sources || '[]'),
  });
});

app.get('/api/books/:id/cover', async (req, res) => {
  const { rows } = await db.execute({
    sql: 'SELECT cover_mime, cover_data FROM books WHERE id = ?',
    args: [req.params.id],
  });
  if (!rows.length || !rows[0].cover_data) return res.status(404).end();
  res
    .set('Content-Type', rows[0].cover_mime || 'image/png')
    .set('Cache-Control', 'public, max-age=31536000, immutable')
    .send(Buffer.from(rows[0].cover_data, 'base64'));
});

app.put('/api/books/:id', async (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: 'UPDATE books SET title = ?, content = ?, updated_at = ? WHERE id = ?',
    args: [String(title).trim(), String(content), now, req.params.id],
  });
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Book not found' });
  res.json({ ok: true, updated_at: now });
});

app.delete('/api/books/:id', async (req, res) => {
  const result = await db.execute({ sql: 'DELETE FROM books WHERE id = ?', args: [req.params.id] });
  if (result.rowsAffected === 0) return res.status(404).json({ error: 'Book not found' });
  res.json({ ok: true });
});

// --- Static frontend (built client) ---
const dist = path.join(root, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`TrueTales running on http://localhost:${port}`));
