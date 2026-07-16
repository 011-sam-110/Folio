# Folio API contract (v1)

Authoritative. Agents implement EXACTLY this; if something is missing, extend without breaking these shapes.
All responses JSON. Errors: `{ "error": string }` with 4xx/5xx status. IDs are lowercase alphanumeric strings.
Timestamps are ISO-8601 UTC strings. Booleans stored as 0/1 in SQLite but serialized as JSON booleans.

## Conventions
- Base: `/api`
- `Note` (full): `{ id, notebookId, title, contentJson (TipTap doc object), contentText, pinned, archived, createdAt, updatedAt, tags: string[], notebook: NotebookLite }`
- `NoteLite` (lists): `{ id, notebookId, title, snippet (plain text ≤160 chars), pinned, archived, updatedAt, createdAt, tags: string[], notebook: NotebookLite, wordCount }`
- `NotebookLite`: `{ id, name, emoji, color }`

## Notebooks — routes/notebooks.ts
- `GET /api/notebooks` → `{ notebooks: [{ id, name, emoji, color, position, archived, noteCount, lastNoteAt }] }` ordered by position.
- `POST /api/notebooks` `{ name, emoji?, color? }` → `{ notebook }` (400 if name empty)
- `PATCH /api/notebooks/:id` `{ name?, emoji?, color?, position?, archived? }` → `{ notebook }` (404 unknown)
- `DELETE /api/notebooks/:id` → `{ ok: true }` (cascades notes)

## Notes — routes/notes.ts
- `GET /api/notes?notebookId=&tag=&archived=0&sort=updated|created|title&limit=50&offset=0` → `{ notes: NoteLite[], total }`
- `GET /api/notes/recent?limit=12` → `{ notes: NoteLite[] }` by updatedAt desc, excludes archived.
- `GET /api/notes/:id` → `{ note: Note, backlinks: NoteLite[], outgoingLinks: NoteLite[] }`
- `POST /api/notes` `{ notebookId, title?, contentJson?, contentText?, tags? }` → `{ note }` (400 bad notebookId)
- `PATCH /api/notes/:id` `{ title?, contentJson?, contentText?, pinned?, archived?, notebookId?, tags? }` → `{ note }` (fields optional; contentJson+contentText travel together)
  - On content change: extract `[[Wiki Links]]` from contentText (regex `\[\[([^\[\]]+)\]\]`), resolve case-insensitively against note titles, replace rows in `links`.
  - Version snapshot policy: on save, if the latest version for this note is older than 10 minutes OR cause differs, insert a version (cause 'autosave'). Always snapshot before 'restore' and before AI rewrites (cause 'ai').
- `DELETE /api/notes/:id` → `{ ok: true }`
- `GET /api/notes/:id/versions` → `{ versions: [{ id, cause, label, createdAt, title, wordCount }] }` desc
- `GET /api/notes/:id/versions/:vid` → `{ version: { id, title, contentJson, cause, label, createdAt } }`
- `POST /api/notes/:id/versions` `{ label? }` → `{ version }` (cause 'manual')
- `POST /api/notes/:id/restore/:vid` → `{ note }` (snapshots current as cause 'restore' first)
- `GET /api/notes/:id/export?format=markdown` → `text/markdown` attachment; convert TipTap JSON → Markdown server-side.
- `GET /api/notes/:id/unlinked-mentions` → `{ notes: NoteLite[] }` — notes whose text mentions this note's title but don't link it.

## Search — routes/search.ts
- `GET /api/search?q=...&limit=20` → `{ results: [{ note: NoteLite, snippetHtml, score }] }`
  - FTS5 `bm25` ranked; `snippetHtml` from `snippet(notes_fts, 1, '<mark>', '</mark>', '…', 12)`.
  - Sanitize q into an FTS MATCH string safely (wrap tokens in double quotes, strip FTS operators; support trailing prefix `*` on last token for search-as-you-type). Empty/invalid q → `{ results: [] }`, never 500.
- `GET /api/search/titles?q=...&limit=10` → `{ results: [{ id, title, notebook: NotebookLite, updatedAt }] }` — fast title contains/prefix match for the quick switcher (Ctrl+K).

## Tags — routes/tags.ts
- `GET /api/tags` → `{ tags: [{ tag, count }] }` ordered by count desc.

## Dashboard — routes/dashboard.ts
- `GET /api/dashboard` → `{ recent: NoteLite[] (8), pinned: NoteLite[], continueNote: NoteLite|null (most recently updated), stats: { notes, notebooks, words, flashcardsDue }, weekActivity: [{ date: 'YYYY-MM-DD', count }] (last 14 days, edits per day from note_versions+notes.updated_at), notebooks: [{ id, name, emoji, color, noteCount, lastNoteAt }] }`

## AI — routes/ai.ts (uses ai/client.ts `chat`; NEVER model 'auto')
All AI endpoints return 502 `{ error, attempts? }` if every model fails. Long-running is fine (≤90s).
- `POST /api/ai/improve` `{ noteId?, text?, instruction? }` → `{ markdown, model }` — rewrite/improve notes (structure, clarity, headings, keep meaning; obey optional instruction). If noteId given, use its contentText; NEVER auto-writes the note — client previews + applies.
- `POST /api/ai/summarize` `{ noteId }` → `{ markdown, model }` — TL;DR + key points + terms.
- `POST /api/ai/flashcards` `{ noteId, count? (default 8) }` → `{ cards: [{ id, question, answer }] }` — generates AND inserts into flashcards table linked to note.
- `POST /api/ai/ask` `{ question, notebookId? }` → `{ answer (markdown), sources: [{ id, title }], model }` — retrieve top 6 notes via FTS on the question keywords, stuff into context with titles, answer with citations by title. Empty corpus → helpful message, not error.
- `POST /api/ai/title` `{ noteId }` → `{ title }` — ≤60 chars, no quotes.
- Prompts live in `ai/prompts.ts`, exported as functions.

## Import — routes/imports.ts (multer; 25MB limit; async jobs)
- `POST /api/import` multipart fields: `file` (required), `kind` = `photo|slides|transcript`, `notebookId` (required for new), `noteId?` (merge target), `mode` = `new|append|improve` (default new) → `{ jobId }`
  - photo: jpeg/png/webp/heic→ vision OCR (send as base64 data URL image_url) → clean structured Markdown (headings, lists, LaTeX-ish math as plain text ok).
  - slides: PDF → unpdf `extractText` per page → AI restructure into a proper lecture-note outline (per-slide headings collapsed into topical sections).
  - transcript: .txt/.md/.pdf → text → AI turn into structured notes / essay feedback per mode.
  - mode `new`: create note titled from content (AI title) in notebookId. `append`: append markdown to existing noteId. `improve`: merge extraction with existing note content → AI produce improved combined note (snapshot version cause 'import' first).
  - Markdown → TipTap JSON conversion happens server-side (lib/markdown.ts) so notes open natively in the editor.
- `GET /api/import/jobs/:id` → `{ id, status: 'queued'|'running'|'done'|'failed', step?: string, noteId?, error?, attachmentId? }` (in-memory job store fine)
- `POST /api/import/image` multipart `file` → `{ url: '/uploads/...' }` — plain image upload for embedding in editor.

## Study — routes/study.ts (SM-2 lite)
- `GET /api/study/queue?limit=20` → `{ cards: [{ id, noteId, noteTitle, question, answer, dueAt, reps }] , due, total }` (due = due_at <= now, not suspended)
- `POST /api/study/review` `{ cardId, rating: 'again'|'hard'|'good'|'easy' }` → `{ card, nextDueAt }`
  - again: reps=0, interval=0 (due now +1min), ease-0.2 (min 1.3); hard: interval*1.2, ease-0.15; good: reps+1, interval = reps==1?1d: interval*ease; easy: interval*(ease+0.15)*1.3, ease+0.15. Log to review_log.
- `GET /api/study/stats` → `{ due, total, reviewedToday, byNote: [{ noteId, noteTitle, total, due }] }`
- `PATCH /api/study/cards/:id` `{ question?, answer?, suspended? }` → `{ card }`
- `DELETE /api/study/cards/:id` → `{ ok: true }`

## Meta — routes/meta.ts (DONE — do not touch)
- `GET /api/meta`, `GET /api/meta/ai-health`, `GET /api/meta/qr`

## Seed — src/seed.ts (`npm run seed -w server`)
Idempotent-ish (safe to rerun: wipes and recreates seed data only when DB empty OR `--force`).
Creates 5 notebooks: 📗 Algorithms & Data Structures, 🗄️ Databases, ⚙️ Operating Systems, 🧩 Software Engineering, ✨ Personal.
≥14 realistic 2nd-year CompSci notes (real content: Big-O, sorting, B-trees, SQL joins & normalisation, transactions, scheduling, paging, deadlock, design patterns, testing, agile, plus personal notes), with tags (#week1..), [[wikilinks]] between related notes, a few pinned, staggered created/updated dates across past weeks, ~12 flashcards across notes (some due now), and 2-3 versions on one note.
TipTap JSON content with varied blocks: headings, bullet/ordered lists, task lists, code blocks with language, blockquotes, callouts if supported, tables.
