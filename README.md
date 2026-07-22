# Unote

A note-taking app for university students. Notebooks and a block editor, wikilinks
and backlinks, full-text search, spaced-repetition flashcards, infinite canvas
boards with Apple Pencil ink, and lecture import that turns a recording into
slides and captions.

**Live: https://folio-dun-six.vercel.app**

---

## What it does

**Writing.** A TipTap block editor with slash commands, callouts, tables, columns,
code blocks, find-and-replace and margin comments. Autosave with version history, so
every note keeps a timeline you can restore from.

**Organising.** Notebooks hold notes; tags cut across them. Type `#revision` in a
note body or add tags as chips in the header. Both feed the same tag vocabulary,
which you can rename, merge or delete across every note at once.

**Linking.** `[[Wikilinks]]` resolve to other notes, and each note shows its
backlinks plus unlinked mentions: places another note names this one without
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
Finger drawing is off by default (stylus draws, finger pans), with a toggle for
touch-only users.

**Sharing.** Publish a note or board behind an unguessable link, optionally
password-gated, view-only or editable. Guests join without an account.

**Lecture import.** Drop in an MP4 and get slides plus a timestamped transcript.
PDF, PPTX and photo import too, with OCR.

**Accounts.** Self-managed, scrypt-hashed with a per-user salt. No email is sent,
so every account gets a one-time recovery key at signup. Shown once, stored only
as a hash.

---

## Running it locally

Requires Node 24+ and a Postgres 14+ instance.

```bash
npm install

# Postgres: anything reachable works; this is the default the app expects
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

**The database layer keeps `?` placeholders.** Unote was originally SQLite +
better-sqlite3. Rather than hand-edit ~95 SQL literals into `$1..$n` during the
Postgres migration (and risk a silent off-by-one in a `WHERE` clause), `db.ts`
mimics better-sqlite3's `prepare(sql).all()` shape and rewrites placeholders
itself. The migration became "add `await`, scope by user" rather than a rewrite of
every route handler.

**Ownership is enforced on the parent, not the child.** Tables like `note_tags`,
`canvas_items` and `note_ink` have no `user_id` of their own. Every query that
touches them joins to the owning note and filters *that*. A bare
`WHERE note_id = ?` would let any signed-in user reach another's data by guessing
an id. `server/test/ownership.test.ts` exists to keep it that way.

**Lecture import runs entirely in the browser.** A Vercel function caps request
bodies at ~4.5 MB and runs for 60 seconds; lecture recordings are hundreds of
megabytes. So slide detection uses the browser's native video decoder plus canvas
frame-differencing, and transcription runs Whisper via transformers.js with WebGPU
where available. Only the extracted slides and captions are ever uploaded; the
video never leaves the machine.

**Collaboration polls rather than sockets.** Serverless functions can't hold a
WebSocket open, so shared notes sync through a monotonic `note_events` feed that
collaborators poll for "everything since revision N". Honest trade-off: it is not
instant, and the UI doesn't pretend otherwise.

---

## Deployment

Deployed on Vercel with Neon Postgres. `DATABASE_URL` is injected by the Neon
marketplace integration; `SESSION_SECRET` must be set explicitly. The server
refuses to boot in production without it, rather than silently signing sessions
with a key that changes per instance.

AI runs against a self-hosted OpenAI-compatible gateway that stacks free provider
tiers. See [docs/AI-DEPLOYMENT.md](docs/AI-DEPLOYMENT.md) for the deploy runbook and
the operational traps.

---

## AI, and who pays for it

AI is free to use and needs no signup beyond an account. Every user starts on a
shared pool funded by one set of free-tier provider keys, metered at 100 calls per
account per month and 1000 per IP. Both ceilings apply, because an account cap on its
own falls to registering twice and an IP cap on its own falls to a phone hotspot.

The IP ceiling is ten times the account one on purpose. This is a student app, and a
university or halls network can put hundreds of legitimate users behind one address;
sizing the two equally would lock out a whole campus once ten people had signed up.

Anyone who wants more can add their own key from any OpenAI-compatible provider under
**Account, AI usage and key**. Those calls authenticate with that key, bill to its
owner, and skip the quota entirely. Keys are encrypted with AES-256-GCM before
storage and the server only ever shows their last four characters.

Counters live in Postgres rather than in memory. The in-memory limiter used on the
auth routes is the right shape for stopping a burst and the wrong shape for a monthly
budget: serverless instances are short-lived and numerous, so an in-process counter
resets constantly and the effective ceiling becomes the limit times the number of warm
instances.

---

## Known limitations

- **AI features need a reachable gateway.** They point at an OpenAI-compatible
  endpoint via `FOLIO_AI_BASE_URL`, which defaults to a local instance. That default
  is fine for development and wrong for production: a serverless function has no
  localhost, so the value must be a public URL once deployed. Without a reachable one
  the AI affordances report themselves unavailable, and everything else works normally.
- **The shared AI pool is one set of free tiers.** Heavy months can exhaust the
  upstream providers before anyone reaches their own quota, in which case calls fail
  with a gateway error rather than a quota message. Users with their own key are
  unaffected.
- **In-browser transcription is slow.** Measured on a real 53-minute lecture: 47s to
  detect slides, then 9m29s to transcribe on CPU (~5.6x realtime). It is a background
  job with progress and a cancel button, not a two-second operation. The WebGPU path
  is **unverified**: it could not be exercised in headless testing, and the speed
  figures in `models.ts` are conservative estimates, labelled as such in the code.
- **Slide detection is tuned on one course.** 94.1% precision and recall across three
  lectures from the same module (same lecturer, same deck template, webcam overlay
  bottom-right). Generalisation to other decks is unproven. The review filmstrip lets
  you delete false positives before committing, so the tuning favours recall.
- **The client bundle is large** and not yet code-split.
- **Renaming a tag doesn't rewrite `#hashtags` already typed into note bodies**, so
  an inline tag reappears next time that note saves. The tag manager says so
  explicitly rather than hiding it.
