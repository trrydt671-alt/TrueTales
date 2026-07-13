import crypto from 'node:crypto';
import { db } from './db.js';

// Text provider: 'gemini' (default, free tier w/ Google Search grounding)
// or 'anthropic' (premium prose, ~$0.10-0.30/book).
const TEXT_PROVIDER = (process.env.TEXT_PROVIDER || 'gemini').toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

const LENGTHS = {
  short:  { label: 'Short',  words: '800-1200 words',  maxTokens: 5000  },
  medium: { label: 'Medium', words: '1500-2500 words', maxTokens: 9000  },
  long:   { label: 'Long',   words: '3000-4000 words', maxTokens: 16000 },
};

const TONES = {
  dramatic:    'Dramatic - high stakes, rising tension, vivid turning points',
  dark:        'Dark & Haunting - unsettling atmosphere, shadows of the story, what history would rather forget',
  heroic:      'Heroic - courage, conviction, the best of what this subject did or stood for',
  adventurous: 'Adventurous - momentum, journeys, risk, the thrill of the unknown',
  tragic:      'Tragic - loss, downfall, the weight of what could not be undone',
  triumphant:  'Triumphant - obstacles overcome, vindication, hard-won victory',
  mysterious:  'Mysterious - open questions, contested accounts, what remains unknown',
  intimate:    'Intimate & Human - small personal details, private moments, the person behind the name',
  witty:       'Witty & Playful - light touch, irony, the absurd and delightful sides of the story',
};

const SYSTEM_PROMPT = `You are a narrative nonfiction author in the tradition of Erik Larson and Laura Hillenbrand. You write short, gripping, rigorously factual books.

NON-NEGOTIABLE RULES:
1. RESEARCH FIRST. Before writing a single word of the book, search the web - multiple searches from different angles (biography, timeline, key events, lesser-known details, contemporary accounts). Never rely on memory alone, especially for lesser-known subjects.
2. EVERY factual claim must be grounded in your search results: names, dates, places, events, numbers. Never invent quotes, dialogue, thoughts, or scenes. You may only quote words that appear in your sources.
3. If sources are thin or contradictory, say so gracefully inside the narrative ("accounts differ", "little is recorded") and write a shorter honest book rather than padding with invention.
4. Within those constraints, write with real craft: scene-setting, tension, momentum, a strong narrative voice. Atmosphere and interpretation are welcome; fabricated facts are not.

OUTPUT FORMAT - respond with ONLY the book, in Markdown:
- Line 1: "# <evocative title>" (a real book title, not just the subject's name)
- Optionally a one-line italic subtitle
- Then 3-7 chapters, each starting with "## <chapter title>"
- No preamble, no closing notes, no meta-commentary.`;

function buildUserPrompt({ subject, extraContext, lengthSpec, toneList }) {
  const toneText = toneList.length
    ? `Tone and angle (blend these): ${toneList.join('; ')}`
    : 'Tone: engaging narrative nonfiction';
  return `Write a factually accurate narrative nonfiction book about: ${subject}
${extraContext ? `\nAdditional context from the reader: ${extraContext}` : ''}
Target length: ${lengthSpec.words}.
${toneText}

Research thoroughly with web search first, then write the book.`;
}

// ---------------------------------------------------------------------------
// In-memory job store (single-user app, single instance)
// ---------------------------------------------------------------------------
const jobs = new Map();

export function getJob(id) {
  return jobs.get(id) || null;
}

export function requiredKeyError() {
  if (!process.env.GEMINI_API_KEY) return 'Server is missing GEMINI_API_KEY';
  if (TEXT_PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    return 'TEXT_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set';
  }
  return null;
}

export function startGeneration({ subject, extraContext, length, tones }) {
  const id = crypto.randomUUID();
  const job = { id, status: 'researching', bookId: null, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  run(job, { subject, extraContext, length, tones }).catch((err) => {
    console.error('Generation failed:', err);
    job.status = 'error';
    job.error = err.message || 'Generation failed';
  });
  setTimeout(() => jobs.delete(id), 60 * 60 * 1000).unref?.();
  return id;
}

async function run(job, { subject, extraContext, length, tones }) {
  const lengthSpec = LENGTHS[length] || LENGTHS.medium;
  const toneList = (tones || []).map((t) => TONES[t]).filter(Boolean);
  const params = { subject, extraContext, lengthSpec, toneList, job };

  // 1. Research + write (web search grounding is mandatory in both providers)
  job.status = 'researching';
  const { markdown, sources } =
    TEXT_PROVIDER === 'anthropic' ? await writeBookAnthropic(params) : await writeBookGemini(params);

  // 2. Cover image (Gemini, with graceful SVG fallback)
  job.status = 'illustrating';
  const title = extractTitle(markdown) || subject;
  let cover;
  try {
    cover = await generateCover({ title, subject, toneList });
  } catch (err) {
    console.error('Cover generation failed, using fallback:', err.message);
    cover = svgFallbackCover(title);
  }

  // 3. Save
  job.status = 'saving';
  const bookId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO books (id, title, subject, extra_context, tones, length, content,
          cover_mime, cover_data, sources, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      bookId, title, subject, extraContext || '', JSON.stringify(tones || []), length,
      markdown, cover.mime, cover.data, JSON.stringify(sources), now, now,
    ],
  });

  job.bookId = bookId;
  job.status = 'done';
}

// ---------------------------------------------------------------------------
// Gemini writer (default): Google Search grounding, free tier
// ---------------------------------------------------------------------------
async function writeBookGemini({ subject, extraContext, lengthSpec, toneList, job }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the server');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt({ subject, extraContext, lengthSpec, toneList }) }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        // headroom so internal "thinking" tokens don't eat the book's budget
        maxOutputTokens: lengthSpec.maxTokens + 4096,
        temperature: 0.9,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  job.status = 'writing';

  const cand = data.candidates?.[0];
  let markdown = (cand?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!markdown) {
    throw new Error(`The model returned no book text (finishReason: ${cand?.finishReason || 'unknown'})`);
  }

  const sources = [];
  const seen = new Set();
  for (const chunk of cand?.groundingMetadata?.groundingChunks || []) {
    const w = chunk.web;
    if (w?.uri && !seen.has(w.uri)) {
      seen.add(w.uri);
      sources.push({ url: w.uri, title: w.title || w.uri });
    }
  }

  if (!markdown.startsWith('#')) markdown = `# ${subject}\n\n${markdown}`;
  return { markdown, sources: sources.slice(0, 25) };
}

// ---------------------------------------------------------------------------
// Anthropic writer (optional premium mode: TEXT_PROVIDER=anthropic)
// ---------------------------------------------------------------------------
async function writeBookAnthropic({ subject, extraContext, lengthSpec, toneList, job }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: lengthSpec.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt({ subject, extraContext, lengthSpec, toneList }) }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  job.status = 'writing';

  let markdown = '';
  const sources = [];
  const seen = new Set();
  for (const block of data.content || []) {
    if (block.type === 'text') {
      markdown += block.text;
      for (const c of block.citations || []) {
        if (c.url && !seen.has(c.url)) {
          seen.add(c.url);
          sources.push({ url: c.url, title: c.title || c.url });
        }
      }
    }
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === 'web_search_result' && r.url && !seen.has(r.url)) {
          seen.add(r.url);
          sources.push({ url: r.url, title: r.title || r.url });
        }
      }
    }
  }

  markdown = markdown.trim();
  if (!markdown) throw new Error('The model returned no book text');
  if (!markdown.startsWith('#')) markdown = `# ${subject}\n\n${markdown}`;
  return { markdown, sources: sources.slice(0, 25) };
}

// ---------------------------------------------------------------------------
// Gemini: cover image
// ---------------------------------------------------------------------------
async function generateCover({ title, subject, toneList }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const mood = toneList.length ? toneList.map((t) => t.split(' - ')[0]).join(', ') : 'evocative';
  const prompt = `A beautiful illustrated book cover for a narrative nonfiction book titled "${title}", about ${subject}. Mood: ${mood}. Painterly, stylized, rich atmospheric color, strong central composition, portrait orientation. Absolutely no text, letters, or typography in the image.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;

  const attempt = async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData?.data);
    if (!img) throw new Error('Gemini returned no image');
    return { mime: img.inlineData.mimeType || 'image/png', data: img.inlineData.data };
  };

  try {
    return await attempt({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { imageConfig: { aspectRatio: '3:4' } },
    });
  } catch {
    return await attempt({ contents: [{ parts: [{ text: prompt }] }] });
  }
}

function svgFallbackCover(title) {
  const palettes = [
    ['#7a5c9e', '#c47a5a'], ['#3f6d5a', '#c9a86a'], ['#5a4632', '#b56a5a'],
    ['#31485e', '#8fa98f'], ['#6d3f4e', '#d9a566'],
  ];
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [c1, c2] = palettes[hash % palettes.length];
  const safe = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const words = safe.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 16) { if (line) lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  const tspans = lines.slice(0, 5)
    .map((l, i) => `<tspan x="300" dy="${i === 0 ? 0 : 64}">${l}</tspan>`) 
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="600" height="800" fill="url(#g)"/>
  <rect x="36" y="36" width="528" height="728" fill="none" stroke="#faf6ef" stroke-opacity="0.55" stroke-width="3"/>
  <text x="300" y="${400 - (lines.length - 1) * 32}" text-anchor="middle" font-family="Georgia, serif"
    font-size="52" fill="#faf6ef" font-weight="bold">${tspans}</text>
</svg>`;
  return { mime: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
}

function extractTitle(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim().replace(/[*_#]/g, '').trim() : null;
}
