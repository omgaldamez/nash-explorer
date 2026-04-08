# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nash Explorer is a press conference phrase analyzer and interactive visualization. It fetches data from a Qdrant vector database, generates a static JSON file, and renders it as an interactive D3.js scatter plot explorer in a single-page HTML app.

## Architecture

**Data flow:**
```
Qdrant DB (Nash collection) → generate_data.py → data.json → index.html (D3.js viz)
```

- **`generate_data.py`** — connects to Qdrant using `QDRANT_URL` and `QDRANT_API_KEY` env vars, scrolls up to 5000 points, filters by `SCORE_MIN=2`, and writes `data.json`
- **`data.json`** — generated artifact (committed to repo); each record has: `keyword`, `fecha` (DD/MM/YYYY), `subject`, `score`, `frase`
- **`index.html`** — single-file frontend; loads `data.json` via `fetch`, renders a sticky D3.js scatter plot grouped by keyword (x = month, y = score with seeded jitter), scroll-driven section highlighting
- **`data/db_frases.csv`** — source CSV (not directly consumed by the app; data lives in Qdrant)

## Running & Development

**Regenerate data.json locally:**
```bash
export QDRANT_URL=<url>
export QDRANT_API_KEY=<key>
pip install -r requirements.txt
python generate_data.py
```

**Serve the frontend locally** (any static server works):
```bash
python -m http.server 8080
# then open http://localhost:8080
```

## CI/CD

GitHub Actions workflow (`.github/workflows/update.yml`) runs every Monday at 06:00 UTC (and on manual dispatch). It regenerates `data.json` using repo secrets `QDRANT_URL` and `QDRANT_API_KEY`, then auto-commits if changed with message `chore: actualizar data.json [skip ci]`.

## Key Implementation Details

- The frontend has no build step — all logic is in `index.html` with D3.js loaded from CDN
- Max 8 keywords are shown (top by frequency); keywords are extracted and deduplicated client-side
- Dot x-positions within a month use a seeded PRNG (based on `frase` content hash) to keep layout stable across renders
- The app is in Spanish; subjects/keywords come from the Qdrant payload fields `keyword`, `fecha`, `subject`, `score`, `frase`
