import crypto from 'node:crypto';
import { db } from './db.js';

// Text provider: 'gemini' (default, free tier w/ Google Search grounding)
// or 'anthropic' (premium prose, ~$0.10-0.30/book).
const TEXT_PROVIDER = (process.env.TEXT_PROVIDER || 'gemini').toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash';

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
  if (TEXT_PROVIDER === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) return 'TEXT_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set';
    return null;
  }
  if (!process.env.GEMINI_API_KEY) return 'Server is missing GEMINI_API_KEY';
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

  // 1. Research + write
  job.status = 'researching';
  let result;
  if (TEXT_PROVIDER === 'anthropic') {
    result = await writeBookAnthropic(params);
  } else {
    try {
      // Best case: Gemini researches the live web itself (search grounding).
      result = await writeBookGemini(params);
    } catch (err) {
      // Search grounding has zero quota on many free keys. Fall back to doing
      // the research ourselves: fetch Wikipedia articles (free, keyless) and
      // have Gemini write strictly from that verified material.
      console.error('Grounded generation unavailable, using Wikipedia research:', err.message);
      job.status = 'researching';
      result = await writeBookFromWikipedia(params);
    }
  }
  const { markdown, sources } = result;

  // 2. Cover: designed typographic SVG - no image API, nothing to fail or cost
  job.status = 'illustrating';
  const title = extractTitle(markdown) || subject;
  const cover = svgCover({ title, subject, tones: tones || [] });

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
// fetch with one retry on rate-limit / transient errors
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, options) {
  let res = await fetch(url, options);
  if (res.status === 429 || res.status >= 500) {
    // wait 30s and try once more (free-tier per-minute limits recover quickly)
    await new Promise((r) => setTimeout(r, 30000));
    res = await fetch(url, options);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Gemini plumbing: model self-discovery + failover.
// Asks Google which models this key can use, ranks them (newest Flash first),
// and fails over on 404 (retired) / 429 (out of quota), so Google renaming or
// retiring models never breaks the app.
// ---------------------------------------------------------------------------
const STATIC_FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'];
let cachedModelList = null; // { list, at }
let workingModel = null;    // last model that succeeded

async function geminiCandidates(apiKey) {
  if (process.env.GEMINI_TEXT_MODEL) return [process.env.GEMINI_TEXT_MODEL];
  try {
    if (!cachedModelList || Date.now() - cachedModelList.at > 60 * 60 * 1000) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1000`
      );
      if (!res.ok) throw new Error(`ListModels returned ${res.status}`);
      const data = await res.json();
      const exclude = /image|imagen|embed|tts|audio|live|veo|aqa|learnlm|robotics|gemma|nano|omni/i;
      const names = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter((n) => /gemini/i.test(n) && !exclude.test(n));
      const ver = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
      // rank: stable flash > preview/exp flash > flash-lite > everything else; newer versions first
      const tier = (n) =>
        /flash-lite/.test(n) ? 2 : /flash/.test(n) ? (/preview|exp/.test(n) ? 1 : 0) : 3;
      names.sort((a, b) => tier(a) - tier(b) || ver(b) - ver(a));
      const seen = new Set();
      const list = [];
      for (const n of names) {
        const base = n.replace(/-\d{3}$/, '');
        if (!seen.has(base)) { seen.add(base); list.push(n); }
      }
      cachedModelList = { list: list.slice(0, 6), at: Date.now() };
      console.log('Gemini models discovered:', cachedModelList.list.join(', '));
    }
    return cachedModelList.list.length ? cachedModelList.list : STATIC_FALLBACK_MODELS;
  } catch (err) {
    console.error('Model discovery failed, using static fallback list:', err.message);
    return STATIC_FALLBACK_MODELS;
  }
}

// Run one generateContent request across candidate models until one succeeds.
async function geminiGenerateWithFailover({ apiKey, requestBody, label }) {
  const discovered = await geminiCandidates(apiKey);
  const candidates = [...new Set([...(workingModel ? [workingModel] : []), ...discovered])];
  const attempts = [];

  for (const model of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
    } catch {
      attempts.push(`${model}: network error`);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      attempts.push(`${model}: HTTP ${res.status}`);
      if ([400, 403, 404, 429].includes(res.status)) continue; // try next model
      throw new Error(`Gemini API error ${res.status} (${model}): ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) {
      attempts.push(`${model}: empty response (${cand?.finishReason || 'unknown'})`);
      continue;
    }
    workingModel = model;
    return { text, cand };
  }

  throw new Error(`${label}: no Gemini model succeeded. Tried -> ${attempts.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Strategy A: Gemini with Google Search grounding (best research, but the
// grounding feature has zero free quota on many keys).
// ---------------------------------------------------------------------------
async function writeBookGemini({ subject, extraContext, lengthSpec, toneList, job }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the server');

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt({ subject, extraContext, lengthSpec, toneList }) }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      maxOutputTokens: lengthSpec.maxTokens + 4096,
      temperature: 0.9,
    },
  });

  const { text, cand } = await geminiGenerateWithFailover({ apiKey, requestBody, label: 'Search-grounded writing' });
  job.status = 'writing';

  const sources = [];
  const seen = new Set();
  for (const chunk of cand?.groundingMetadata?.groundingChunks || []) {
    const w = chunk.web;
    if (w?.uri && !seen.has(w.uri)) {
      seen.add(w.uri);
      sources.push({ url: w.uri, title: w.title || w.uri });
    }
  }

  let markdown = text;
  if (!markdown.startsWith('#')) markdown = `# ${subject}\n\n${markdown}`;
  return { markdown, sources: sources.slice(0, 25) };
}

// ---------------------------------------------------------------------------
// Strategy B: research Wikipedia ourselves (free, keyless, no quota), then
// have Gemini write strictly from that material - a plain generateContent
// call, which has a real free-tier quota.
// ---------------------------------------------------------------------------
const WIKI_HEADERS = { 'user-agent': 'TrueTales/1.0 (personal library app)' };

async function researchWikipedia(subject, extraContext) {
  const query = [subject, extraContext].filter(Boolean).join(' ').slice(0, 250);
  const searchUrl =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=' +
    encodeURIComponent(query);
  const sres = await fetch(searchUrl, { headers: WIKI_HEADERS });
  if (!sres.ok) throw new Error(`Wikipedia search failed (${sres.status})`);
  const sdata = await sres.json();
  const titles = (sdata.query?.search || []).map((r) => r.title).slice(0, 4);
  if (!titles.length) {
    throw new Error(`No Wikipedia articles found for "${subject}". Try adding more detail (full name, what they are known for).`);
  }

  const pages = [];
  for (const title of titles) {
    if (pages.length >= 3) break;
    const exUrl =
      'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=' +
      encodeURIComponent(title);
    try {
      const eres = await fetch(exUrl, { headers: WIKI_HEADERS });
      if (!eres.ok) continue;
      const edata = await eres.json();
      const page = Object.values(edata.query?.pages || {})[0];
      const extract = (page?.extract || '').trim();
      if (!extract || /may refer to[:\s]/i.test(extract.slice(0, 200))) continue; // skip disambiguation
      pages.push({
        title: page.title || title,
        url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent((page.title || title).replace(/ /g, '_')),
        text: extract.slice(0, 14000),
      });
    } catch { /* skip page */ }
  }

  if (!pages.length) throw new Error(`Could not fetch usable Wikipedia material for "${subject}".`);
  return pages;
}

const SYSTEM_PROMPT_FROM_MATERIAL = `You are a narrative nonfiction author in the tradition of Erik Larson and Laura Hillenbrand. You write short, gripping, rigorously factual books.

The user message contains RESEARCH MATERIAL fetched from Wikipedia. That material is your ONLY permitted source of facts.

NON-NEGOTIABLE RULES:
1. EVERY factual claim - names, dates, places, events, numbers - must come from the research material. Never add facts from memory. Never invent quotes, dialogue, thoughts, or scenes. You may only quote words that appear in the material.
2. If the material is thin or contradictory, say so gracefully inside the narrative ("accounts differ", "little is recorded") and write a shorter honest book rather than padding with invention.
3. Within those constraints, write with real craft: scene-setting, tension, momentum, a strong narrative voice. Atmosphere and interpretation are welcome; fabricated facts are not.

OUTPUT FORMAT - respond with ONLY the book, in Markdown:
- Line 1: "# <evocative title>" (a real book title, not just the subject's name)
- Optionally a one-line italic subtitle
- Then 3-7 chapters, each starting with "## <chapter title>"
- No preamble, no closing notes, no meta-commentary.`;

async function writeBookFromWikipedia({ subject, extraContext, lengthSpec, toneList, job }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the server');

  const pages = await researchWikipedia(subject, extraContext);
  const material = pages
    .map((p, i) => `--- SOURCE ${i + 1}: ${p.title} (${p.url}) ---\n${p.text}`)
    .join('\n\n');

  const userPrompt = buildUserPrompt({ subject, extraContext, lengthSpec, toneList }) +
    `\n\nRESEARCH MATERIAL (your only permitted source of facts):\n\n${material}`;

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT_FROM_MATERIAL }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      maxOutputTokens: lengthSpec.maxTokens + 4096,
      temperature: 0.9,
    },
  });

  const { text } = await geminiGenerateWithFailover({ apiKey, requestBody, label: 'Writing from Wikipedia research' });
  job.status = 'writing';

  let markdown = text;
  if (!markdown.startsWith('#')) markdown = `# ${subject}\n\n${markdown}`;
  return { markdown, sources: pages.map((p) => ({ url: p.url, title: `Wikipedia: ${p.title}` })) };
}

// ---------------------------------------------------------------------------
// Anthropic writer (optional premium mode: TEXT_PROVIDER=anthropic)
// ---------------------------------------------------------------------------
async function writeBookAnthropic({ subject, extraContext, lengthSpec, toneList, job }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
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
// Designed typographic SVG covers - no image API needed
// ---------------------------------------------------------------------------
const TONE_PALETTES = {
  dramatic:    { bg1: '#5b2333', bg2: '#2b1016', accent: '#e8b04b' },
  dark:        { bg1: '#1e2430', bg2: '#0c0f16', accent: '#9db4d0' },
  heroic:      { bg1: '#1f4e5f', bg2: '#12303b', accent: '#e8c46b' },
  adventurous: { bg1: '#2e5e4e', bg2: '#1a3a2f', accent: '#e9a15c' },
  tragic:      { bg1: '#4a3b52', bg2: '#241c2b', accent: '#c9a3b5' },
  triumphant:  { bg1: '#8a4a2b', bg2: '#4f2917', accent: '#f0d491' },
  mysterious:  { bg1: '#2f3550', bg2: '#171a2c', accent: '#8fd0c6' },
  intimate:    { bg1: '#7a5844', bg2: '#4a3427', accent: '#f2ddc2' },
  witty:       { bg1: '#3d6a6a', bg2: '#234444', accent: '#f2c14e' },
};
const DEFAULT_PALETTES = Object.values(TONE_PALETTES);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrap(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function svgCover({ title, subject, tones }) {
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;

  const pal = TONE_PALETTES[tones?.[0]] || DEFAULT_PALETTES[hash % DEFAULT_PALETTES.length];

  // Title sizing: shorter titles get bigger type
  const titleLines = wrap(esc(title), 14).slice(0, 5);
  const fontSize = titleLines.length <= 2 ? 60 : titleLines.length === 3 ? 52 : 44;
  const lineH = Math.round(fontSize * 1.22);
  const blockH = (titleLines.length - 1) * lineH;
  const titleY = 400 - Math.round(blockH / 2);
  const tspans = titleLines
    .map((l, i) => `<tspan x="300" dy="${i === 0 ? 0 : lineH}">${l}</tspan>`)
    .join('');

  const allSubjectLines = wrap(esc(subject), 30);
  const subjectLines = allSubjectLines.slice(0, 2);
  if (allSubjectLines.length > 2) subjectLines[1] += '\u2026';
  const subjectSpans = subjectLines
    .map((l, i) => `<tspan x="300" dy="${i === 0 ? 0 : 26}">${l}</tspan>`)
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${pal.bg1}"/>
      <stop offset="1" stop-color="${pal.bg2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="600" height="800" fill="url(#bg)"/>
  <rect width="600" height="800" fill="url(#glow)"/>

  <!-- spine shadow for a physical-book feel -->
  <rect x="0" y="0" width="26" height="800" fill="#000000" opacity="0.18"/>

  <!-- double frame -->
  <rect x="42" y="42" width="516" height="716" fill="none" stroke="${pal.accent}" stroke-opacity="0.85" stroke-width="2.5"/>
  <rect x="52" y="52" width="496" height="696" fill="none" stroke="${pal.accent}" stroke-opacity="0.35" stroke-width="1"/>

  <!-- top ornament: drawn diamond motif (renders identically everywhere) -->
  <g fill="${pal.accent}" stroke="${pal.accent}">
    <rect x="289" y="109" width="22" height="22" transform="rotate(45 300 120)" fill-opacity="0.9" stroke="none"/>
    <rect x="294" y="114" width="12" height="12" transform="rotate(45 300 120)" fill="${pal.bg2}" stroke="none"/>
    <line x1="230" y1="120" x2="278" y2="120" stroke-width="1.5" stroke-opacity="0.7"/>
    <line x1="322" y1="120" x2="370" y2="120" stroke-width="1.5" stroke-opacity="0.7"/>
  </g>
  <line x1="210" y1="158" x2="390" y2="158" stroke="${pal.accent}" stroke-opacity="0.6" stroke-width="1"/>

  <!-- series label -->
  <text x="300" y="196" text-anchor="middle" font-family="Georgia, serif" font-size="17"
    letter-spacing="6" fill="${pal.accent}" fill-opacity="0.9">A TRUE TALE</text>

  <!-- title -->
  <text x="300" y="${titleY}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
    font-size="${fontSize}" font-weight="bold" fill="#f7f1e5">${tspans}</text>

  <!-- bottom rule + subject -->
  <line x1="210" y1="652" x2="390" y2="652" stroke="${pal.accent}" stroke-opacity="0.6" stroke-width="1"/>
  <text x="300" y="688" text-anchor="middle" font-family="Georgia, serif" font-size="20"
    font-style="italic" fill="${pal.accent}">${subjectSpans}</text>
</svg>`;

  return { mime: 'image/svg+xml', data: Buffer.from(svg, 'utf8').toString('base64') };
}

function extractTitle(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim().replace(/[*_#]/g, '').trim() : null;
}
