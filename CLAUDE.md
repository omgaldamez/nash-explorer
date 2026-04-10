# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nash Explorer is an interactive scrollytelling visualization of Mexican presidential press conference transcriptions. Data lives in a Qdrant vector database; a Cloudflare Worker serves both the visualization data and a RAG (Retrieval-Augmented Generation) search endpoint. The frontend is a single HTML file with p5.js.

## Architecture

**Data flow:**
```
Qdrant DB (Nash collection)
    └── Cloudflare Worker (nash-api)
            ├── GET /data  → builds and returns viz JSON (cached 1h)
            └── POST /query → Gemini embedding + Qdrant search + Gemini 2.5-flash answer
                    └── index.html (p5.js viz + RAG tab)
```

### Files

- **`index.html`** — single-file frontend; all CSS + JS inline, no build step. Loads viz data from Worker `GET /data`, renders a sticky p5.js scatter plot. Also contains the Consultar (RAG) tab.
- **`worker/src/index.js`** — Cloudflare Worker. Three endpoints: `GET /`, `GET /data`, `POST /query`. Secrets: `QDRANT_URL`, `QDRANT_API_KEY`, `GEMINI_API_KEY`.
- **`worker/wrangler.toml`** — Worker config (`name = "nash-api"`, `workers_dev = true`).
- **`worker/package.json`** — only dependency: `wrangler ^3.0.0`.

### Deleted / no longer needed
- `generate_data.py`, `build_data.py` — replaced by `buildData()` in the Worker
- `data.json`, `data/db_frases.csv` — data is served live from Qdrant
- `.github/workflows/update.yml` — no longer regenerates anything
- `requirements.txt` — no Python dependencies remain

## Running & Development

**Worker (local dev):**
```bash
cd worker
npm install
wrangler dev
# exposes http://localhost:8787
```

**Worker secrets (first time or after rotation):**
```bash
wrangler secret put QDRANT_URL
wrangler secret put QDRANT_API_KEY
wrangler secret put GEMINI_API_KEY
```

**Deploy Worker:**
```bash
cd worker
wrangler deploy
```

**Frontend (local):**
```bash
# From repo root — any static server works
python -m http.server 8080
# Open http://localhost:8080
# Note: WORKER_URL in index.html points to the deployed worker.
# For local worker, change WORKER_URL to 'http://localhost:8787'
```

## Key Implementation Details

### Frontend (index.html)

- **No build step** — all logic is inline; edit and refresh
- **`WORKER_URL`** constant at top of `<script>` — change to point at local or prod worker
- **`PALETTE` / `PAL_LIGHT`** — 8 neon colors (dark mode) and 8 darker equivalents (light mode). `activePalette()` and `CL(i)` switch automatically on theme change
- **`MAX_KW = 8`** — top 8 keywords by frequency are shown
- **p5.js sketch** runs inside `#chart-area` div using instance mode
- **Two nav modes:** `navMode='kw'` (keyword sections, scroll highlights per keyword) and `navMode='time'` (temporal, scroll highlights per month with day-stack view)
- **Two x-axis view modes:** `viewMode='month'` (band scale) and `viewMode='day'` (time scale) — only active in `navMode='kw'`
- **`dayStackMo`** — when `>= 0`, temporal mode is showing day-level detail for that month index; axis switches to week bands + day columns
- **Seeded RNG (`makeRng(42)`)** — same algorithm in both Worker (`buildData`) and frontend (`normalizeOldFormat`); ensures stable dot positions across renders
- **`_dayAxisParams`** — shared object between `computeTargetsDayStack` and `drawDayAxis` inside p5; contains `{ daysInMonth, bw, MB }`
- **Scroll → section mapping:** `SH = 380` — each section is 380px tall; `Math.floor(scrollY / SH)` maps to section index
- **Theme toggle** dispatches `CustomEvent('themechange')` — `renderSections()` and `renderLegend()` listen and re-render with correct palette

### Worker (worker/src/index.js)

- **`buildData(points)`** — replicates the old `build_data.py`; filters `score >= 2`, top 8 keywords, same seeded RNG, returns `{ kw, kwN, mo, dayMs, dots }`
- **Module-level cache** (`_dataCache`, `_dataCacheTime`, `CACHE_TTL = 1h`) — avoids re-scrolling Qdrant on every request
- **`scrollAllQdrant`** — paginates with `next_page_offset` until exhausted
- **Gemini models used:** `gemini-embedding-001` (embeddings), `gemini-2.5-flash` (generation)
- **CORS:** `Access-Control-Allow-Origin: *` — change if you need to restrict origins
