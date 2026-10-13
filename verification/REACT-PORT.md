# The Meadows react — port notes and verification record

**Created:** 2026-10-13 · **Source of record:** `../Hive-Nectar-Website-02-aug2026/` (the live static site)
**Target:** this folder — the React (Vite) port. All future development happens here.

## What this is

A Vite + React app that serves the existing site **verbatim**: every original page
lives untouched at `src/legacy/<page>.html` and is mounted by
`src/components/LegacyPage.jsx` → `src/lib/legacy.js`, with a custom
`legacyHtmlFallback()` plugin in `vite.config.js` mapping `/<page>.html` to the
SPA shell. Nothing in the original markup, CSS, JS or assets was rewritten for
the port, so behaviour is preserved by construction and provable by diff.

## Run it

    npm install
    npm run dev        # dev  → http://localhost:5210  (strictPort)
    npm run build      # build → dist/
    npm run preview    # serve dist → http://localhost:5211 (strictPort)

Ports are pinned in `vite.config.js` (5210 dev / 5211 preview) so they never
collide with the static baseline on 5173.

## Deploy

`vercel.json` is committed: framework `vite`, `npm run build`, output `dist`, and
a rewrite sending `/<page>.html` to `/index.html`. The app reads **no** private
keys — only the public Supabase anon key already shipped in `js/supabase-config.js`.
Never put `SUPABASE_SERVICE_ROLE_KEY` or `STRIPE_SECRET_KEY` in a `VITE_` variable.

## Verification (all measured, not asserted)

| check | tool | result |
| --- | --- | --- |
| Every shipped file byte-identical to the source tree | `make-manifest.py` | **87 / 87**, 0 mismatches, 0 missing |
| Every local href/src/fetch resolves | `asset_audit.py` | pass |
| Visible text per page (exact hash) | `parity.py` | **24 / 24 identical** |
| Element census (mount wrappers excluded) | `parity.py` | **24 / 24 identical**, 0 unexplained deltas |
| Pixels vs the live static site | `parity.py` | **24 / 24 at 100.000 %** — 0 differing pixels in total |
| Console errors | `capture.py` | React ≤ static on every page (CRM.html 1 → 0) |
| Authenticated dashboard (`profile.html`) | browser, same session | identical body (3,118 chars), `3% (1/30)`, Achievements 13, filters + social layer present, 0 errors |
| Production build (`dist/`) | `vite preview` | all routes 200, hashed bundle, style.css + Font Awesome loaded, 0 pictographs, 43 `fa-` icons |

The only `script`/`style`/`link` count differences are the mount engine re-wiring the
page's own assets through the SPA (an executed `<script src>` becomes a `blob:` tag;
`style.css` is owned by the shell, so the page's duplicate `<link>` is dropped). No
markup is lost — the element census is otherwise tag-for-tag and the pixels are equal.

### Artefacts

- `FILE-MANIFEST.txt`, `manifest.json` — byte-identity record (87 files)
- `PARITY-REPORT.md`, `parity.json` — per-page text / structure / pixel results
- `react-vs-original.png` — every route, original beside React, delta on the card
- `react-all-pages.png` — contact sheet of the React app
- `authenticated-parity.png` — signed-in dashboard, vanilla vs React
- `authenticated-sole-difference.png` — the one 942-pixel delta (the `21h → 20h
  until unlocked` cooldown clock ticking between the two screenshots)
- `screenshots/{baseline,react}/` — 24 full-page captures each, plus DOM records
- `side-by-side/` — per-route original | React cards

Re-run everything with:
`venv/bin/python verification/{make-manifest,capture,parity,proof-sheet}.py`

## Standing rule

The static tree is now read-only reference. Bug fixes, features and design work go
into **The Meadows react** and are verified against this record before any deploy.
