# Folio

A note-taking app for university students. Notebooks and a block editor, wikilinks
and backlinks, full-text search, spaced-repetition flashcards, infinite canvas
boards with Apple Pencil ink, and lecture import that turns a recording into
slides and captions.

**Live: https://folio-dun-six.vercel.app**

---

## What it does

**Writing.** A TipTap block editor with slash commands, callouts, tables, columns,
code blocks, find-and-replace and margin comments. Autosave with version history —
every note keeps a timeline you can restore from.

**Organising.** Notebooks hold notes; tags cut across them. Type `#revision` in a
note body or add tags as chips in the header — both feed the same tag vocabulary,
which you can rename, merge or delete across every note at once.

**Linking.** `[[Wikilinks]]` resolve to other notes, and each note shows its
backlinks plus unlinked mentions — places another note names this one without
linking it yet.

**Finding.** Postgres full-text search with operators: `tag:algorithms`,
`notebook:"Operating Systems"`, `"exact phrase"`, `-excluded`.

**Studying.** Turn a passage into flashcards and review them on an SM-2 spaced
repetition schedule.

**Canvas.** Notes can be infinite boards instead of documents: sticky notes,
shapes, images, connectors, and cards linking to other notes. Pan, zoom, marquee
select, undo/redo.

**Ink.** Pressure-sensitive stylus drawing, on canvas boards and as a layer over
ordinary document notes. Built on PointerEvents with coalesced-event sampling for
smooth fast strokes, and palm rejection so a resting hand doesn't draw on iPad.
Finger drawing is off by default — stylus draws, finger pans — with a toggle for
touch-only users.

**Sharing.** Publish a note or board behind an unguessable link, optionally
password-gated, view-only or editable. Guests join without an account.

**Lecture import.** Drop in an MP4 and get slides plus a timestamped transcript.
PDF, PPTX and photo import too, with OCR.

**Accounts.** Self-managed, scrypt-hashed with a per-user salt. No email is sent,
so every account gets a one-time recovery key at signup — shown once, stored only
as a hash.

---

## Running it locally

Requires Node 24+ and a Postgres 14+ instance.

```bash
npm install

# Postgres — anything reachable works; this is the default the app expects
docker run -d --name folio-pg -p 5433:5432 \
  -e POSTGRES_USER=folio -e POSTGRES_PASSWORD=folio -e POSTGRES_DB=folio \
  postgres:17-alpine

npm run dev          # api on :4780, web on :5173
```

The schema applies itself on boot; there is no migration step to run.

`cp .env.example .env` to configure the AI gateway and ports. Everything except
the AI features works without any configuration.

```bash
npm run test -w server       # 176 unit + integration tests
node scripts/smoke-api.mjs   # live-server checks against a running instance
npm run e2e                  # Playwright
```

`scripts/smoke-api.mjs` takes `FOLIO_BASE` so the same suite runs against local,
a staging database, or production.

---

## How it's put together

npm workspaces: `server/` (Express 5 + Postgres) and `web/` (React 18 + Vite +
TypeScript), with `api/index.ts` wrapping the Express app as a Vercel serverless
function.

Four decisions worth knowing about, because they're not obvious from the code:

**The database layer keeps `?` placeholders.** Folio was originally SQLite +
better-sqlite3. Rather than hand-edit ~95 SQL literals into `$1..$n` during the
Postgres migration — and risk a silent off-by-one in a `WHERE` clause — `db.ts`
mimics better-sqlite3's `prepare(sql).all()` shape and rewrites placeholders
itself. The migration became "add `await`, scope by user" rather than a rewrite of
every route handler.

**Ownership is enforced on the parent, not the child.** Tables like `note_tags`,
`canvas_items` and `note_ink` have no `user_id` of their own. Every query that
touches them joins to the owning note and filters *that* — a bare
`WHERE note_id = ?` would let any signed-in user reach another's data by guessing
an id. `server/test/ownership.test.ts` exists to keep it that way.

**Lecture import runs entirely in the browser.** A Vercel function caps request
bodies at ~4.5 MB and runs for 60 seconds; lecture recordings are hundreds of
megabytes. So slide detection uses the browser's native video decoder plus canvas
frame-differencing, and transcription runs Whisper via transformers.js with WebGPU
where available. Only the extracted slides and captions are ever uploaded — the
video never leaves the machine.

**Collaboration polls rather than sockets.** Serverless functions can't hold a
WebSocket open, so shared notes sync through a monotonic `note_events` feed that
collaborators poll for "everything since revision N". Honest trade-off: it is not
instant, and the UI doesn't pretend otherwise.

---

## Deployment

Deployed on Vercel with Neon Postgres. `DATABASE_URL` is injected by the Neon
marketplace integration; `SESSION_SECRET` must be set explicitly — the server
refuses to boot in production without it, rather than silently signing sessions
with a key that changes per instance.

---

## Known limitations

- **AI features need a reachable gateway.** They point at an OpenAI-compatible
  endpoint via `FOLIO_AI_BASE_URL`, which defaults to a local instance. Without one
  configured, the AI affordances report themselves unavailable; everything else
  works normally.
- **In-browser transcription is slow.** A full-length lecture is a background job,
  not a two-second operation. WebGPU helps substantially; WASM fallback is slower.
- **The client bundle is large** and not yet code-split.
- **Renaming a tag doesn't rewrite `#hashtags` already typed into note bodies**, so
  an inline tag reappears next time that note saves. The tag manager says so
  explicitly rather than hiding it.
