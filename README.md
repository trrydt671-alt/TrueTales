# TrueTales 📚

A personal-library PWA that writes short, **factually-grounded** narrative nonfiction books about any real person or subject — researched live via web search, never from memory — with AI-painted covers.

## How it works

1. **New book** → enter a name/subject (+ optional context to disambiguate or focus).
2. **Style** → pick a length (Short ~800–1200 / Medium ~1500–2500 / Long ~3000–4000 words) and any mix of tones: Dramatic, Dark & Haunting, Heroic, Adventurous, Tragic, Triumphant, Mysterious, Intimate & Human, Witty & Playful.
3. **Generate** → the server calls Gemini **with Google Search grounding enabled and instructed as mandatory** — the model must research from multiple angles before writing, may only state facts found in sources, and must never invent quotes or scenes. Every book stores its source links, shown in a "Sources" section in the reader. (Optional premium mode: set `TEXT_PROVIDER=anthropic` to have Claude + its web_search tool write instead — better prose, ~$0.10–0.30/book.)
4. A cover is painted by Google Gemini (with a graceful generated-SVG fallback if the image API fails), and the book lands on your shelf.

## Stack (and why)

| Piece | Choice | Why |
|---|---|---|
| Frontend | React + Vite + `vite-plugin-pwa` | Installable PWA with offline shell + cached covers; one modern, boring, reliable toolchain |
| Backend | Node.js + Express | One language across the stack, one deploy artifact (Express serves the built SPA), native `fetch` — only 2 runtime dependencies |
| Database | SQLite via `@libsql/client` | Single-user scale; the same code speaks to a local file **or** a free hosted Turso DB — flip one env var |
| Writing + research | Gemini (`gemini-2.5-flash` + Google Search grounding) | Free tier (~1,500 grounded requests/day) — $0 per book. Claude available as optional premium mode |
| Cover images | Google Gemini (`gemini-2.5-flash-image`) | Free tier, same API key, good stylized-illustration quality |
| Hosting | Render free tier | $0, git-push deploys, serves API + PWA from one URL |

Secrets live only in server env vars. The client never sees an API key.

## Run locally

```bash
cp .env.example .env        # fill in GEMINI_API_KEY (that's all you need)
npm install
npm run build               # builds the client into client/dist
npm start                   # http://localhost:3000
```

For development with hot reload: `npm run dev:server` in one terminal, `npm run dev:client` in another (Vite proxies `/api` to :3000), open http://localhost:5173.

To try it on your phone locally: run `npm start`, find your computer's LAN IP, and open `http://<that-ip>:3000` on the phone (same Wi-Fi).

## Deploy to Render (free)

**1. Get your key**
- Gemini: https://aistudio.google.com/apikey (free) — this one key covers research, writing, and covers
- (Optional, for premium Claude prose: an Anthropic key from https://console.anthropic.com)

**2. Create a free Turso database** (strongly recommended — Render's free tier has an ephemeral disk, so a local SQLite file would be wiped on every deploy/restart)
- https://turso.tech → sign up → Create database
- Copy the **libsql://… URL** and create an **auth token**

**3. Push this folder to a GitHub repo**

```bash
git init && git add -A && git commit -m "TrueTales"
# create a repo on github.com, then:
git remote add origin <your-repo-url> && git push -u origin main
```

**4. Create the Render service**
- https://render.com → New → Web Service → connect your repo
- Render reads `render.yaml` automatically (free plan, build `npm install && npm run build`, start `npm start`)
- Add environment variables: `GEMINI_API_KEY`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN` (leave the Anthropic ones blank unless using premium mode)

**5. Install on your phone**
- Open your `https://<app>.onrender.com` URL
- iPhone: Safari → Share → **Add to Home Screen** · Android: Chrome → menu → **Add to Home screen / Install app**

### Free-tier notes
- The service sleeps after ~15 min idle; the first open takes ~30–60 s to wake. (Fly.io ≈ $2–3/mo removes this.)
- Generation takes 1–3 minutes — real web research isn't instant. The app polls a job endpoint, so a flaky phone connection won't lose the book; it appears on the shelf when done. If the free instance restarts *mid-generation*, that one job is lost — just tap generate again.

## API

```
POST   /api/books/generate   { subject, extraContext?, length, tones[] } → { jobId }
GET    /api/generate/:jobId  → { status, bookId?, error? }
GET    /api/books            → summaries
GET    /api/books/:id        → full book incl. content + sources
GET    /api/books/:id/cover  → cover image
PUT    /api/books/:id        { title, content }
DELETE /api/books/:id
```

## Costs

- Writing + research: **$0** — Gemini free tier includes ~1,500 Google-Search-grounded requests/day on `gemini-2.5-flash`, far more than you'll use.
- Covers: **$0** — Gemini free tier.
- Hosting + DB: **$0** — Render free + Turso free.
- Optional premium mode (`TEXT_PROVIDER=anthropic`): Claude Sonnet + web search ≈ $0.10–0.30/book for noticeably richer prose.
