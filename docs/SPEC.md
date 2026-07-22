# Unote: Product Specification (SPEC.md)

Status: authoritative. Merges five research passes (Notion, Obsidian, Google Docs, student-workflow, and technical-feasibility) into one buildable spec for a single-user, local-first CompSci student notebook.

---

## 1. Product Vision

Unote is the notebook a CompSci student actually needs: a Notion-grade block editor that never asks you to configure a database schema before you can take your first lecture note, an Obsidian-grade web of wikilinks and backlinks that lets you connect ideas across modules without becoming a knowledge-management hobby, and a Google-Docs-grade sense of safety (visible autosave, real version history, real exports) so a whole degree's worth of notes never feels one crash away from gone. It is local-first and runs entirely on the student's own machine (Express + better-sqlite3, LAN-reachable for phone capture), with AI as a first-class but strictly opt-in layer: photograph a handwritten page or a slide deck and get an editable, LaTeX-aware transcription next to the original; ask a question and get an answer synthesized from your own notes, with citations, because no data ever has to leave the laptop. The product succeeds if a 2nd-year student trusts it enough to retire OneNote, Notion, and a phone camera roll full of untranscribed lecture photos in favor of one tool.

---

## 2. Locked Technical Constraints

- **Frontend**: React 18 + Vite + TypeScript + TipTap 3.28.0 (all `@tiptap/*` packages pinned to the same version; mixed versions cause silent duplicate-extension/schema-mismatch bugs).
- **Backend**: Express 5.2.1 + better-sqlite3 12.11.1, single Node process, binds `0.0.0.0` so a phone on the same LAN can reach it.
- **AI**: local OpenAI-compatible gateway at `http://localhost:3001/v1`. Models are **pinned with an explicit fallback list**, never `'auto'` (unreliable routing). Vision-capable model required for OCR/photo-capture.
- **Auth**: none. Single user, local network only. This is an explicit accepted-risk decision, not an oversight (documented in §8).
- **Design**: clean, light, Notion-like visual language by default, with a full-parity dark-mode toggle.
- **Dev/prod serving**: Vite dev server (5173) proxies `/api` to Express (3001) in dev via `concurrently`; in prod, Express serves the Vite `dist/` build with API routes mounted before a `/*splat` SPA catch-all (Express 5's path-to-regexp broke the old bare `app.get('*', ...)` pattern).
- **Windows dev-box gotcha**: better-sqlite3 12.10+ ships no prebuilt binary for Node 20/23. Confirm the dev machine is on Node 24+ LTS before first `npm install`, or a from-source node-gyp compile (Visual Studio Build Tools + Python) blocks day one.

---

## 3. Information Architecture

### 3.1 Model: Notebooks → Notes (+ tags, not a forced rigid hierarchy)

Unote's top-level container is the **Notebook**, in practice one per course/module (`🗄️ Databases`, `🧮 Discrete Maths`). This directly answers the student-research finding that Notion's total flexibility leaves students "configured for nothing" before their first lecture, while avoiding the opposite failure mode of a rigid, forced Term→Module→Week→Session four-level hierarchy that every note must be filed into before it can exist. Instead:

- **Notebook** = course/module (name, emoji, color), the one piece of structure every student already has (their timetable).
- **Note** = a session, a revision page, an essay draft, a personal note: whatever granularity the student wants, living inside exactly one notebook.
- **Tags** (`#week6`, `#lecture`, `#lab`, `#revision`) carry the week/session-type axis the student report wanted, without forcing it. A "Week view" and a "Last time in [Notebook]" dashboard card are both just queries over `(notebook_id, tags, updated_at)`. No schema-level week/term concept required.
- **Wikilinks** cut across notebooks freely, because concepts (Big-O notation, normal forms) don't respect module boundaries any more than a real syllabus does.

This is a deliberate, documented scope cut from the student report's literal Term>Module>Week spine and from Notion's/Obsidian's infinite page-nesting: two levels of real structure (Notebook, Tag) is enough to kill the blank-page problem without adding page-hierarchy engineering (breadcrumbs, arbitrary-depth parent chains) that a single-user student notebook doesn't need in v1.

### 3.2 Database Schema (better-sqlite3, WAL mode, foreign keys on)

```sql
-- Already locked/scaffolded; do not change field names without updating docs/API.md.

CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📓',
  color TEXT NOT NULL DEFAULT '#6366f1',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',  -- full TipTap doc; top-level nodes carry a stable block id via a unique-id extension
  content_text TEXT NOT NULL DEFAULT '',  -- plain-text extraction, kept in sync on every save, drives FTS + link/tag parsing
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- indexes: (notebook_id, updated_at DESC), (updated_at DESC)

CREATE TABLE note_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,          -- full snapshot, not a delta: cheap enough at document scale
  cause TEXT NOT NULL DEFAULT 'autosave',  -- autosave | manual | ai | restore | import
  label TEXT,                          -- set for manual/named checkpoints
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

CREATE TABLE links (           -- resolved wikilinks, parsed server-side from [[Title]] on save
  from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_note_id, to_note_id)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,            -- photo | slides | transcript | image | file
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  extracted_text TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded | extracting | ready | failed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE flashcards (
  id TEXT PRIMARY KEY,
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  anchor_block_id TEXT,           -- NEW: stable block id the card was created from (RemNote-style live link)
  anchor_text TEXT,                -- NEW: the exact source span, for fuzzy re-anchoring after edits
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- index: due_at WHERE suspended = 0

CREATE TABLE review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,           -- again | hard | good | easy
  reviewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, content_text,
  content='notes', content_rowid='rowid',
  tokenize='porter unicode61'
);
-- + AFTER INSERT/DELETE/UPDATE triggers keeping notes_fts in sync (external-content table, no auto-sync)

-- NEW tables for this spec:

CREATE TABLE note_comments (        -- margin notes / self-annotations
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  comment_mark_id TEXT NOT NULL,    -- matches a `commentId` attr on an inline TipTap mark inside content_json
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE INDEX idx_comments_note ON note_comments(note_id, resolved);

CREATE TABLE settings (              -- generic single-row-per-key app settings
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys used in v1: theme ('light'|'dark'|'system'), spellcheck_dictionary (JSON string[]),
-- weekly_review_day (0-6), last_active_notebook_id
```

Why not a true per-block DB table? A note's content is one TipTap JSON document; blocks are addressed by a stable `id` attribute stamped on every top-level node (via a unique-id extension), not by separate rows. This keeps writes simple (one `UPDATE notes SET content_json=?`) while still giving comments, flashcard anchors, and "copy link to block" something durable to point at. Revisit only if synced blocks or block-level transclusion (v2) demand it.

---

## 4. Feature Specification

Priority legend. **must**: MVP-blocking, ship-day non-negotiable. **should**: MVP-ambitious, ship in the first full build unless real time pressure forces a cut. **could**: explicitly deferred to v2+.

### 4.1 Editor & Block Model

| Feature | Priority | Notes |
|---|---|---|
| Paragraph, H1-H3, bulleted/numbered lists (unlimited nesting), task list, blockquote, divider | must | StarterKit + `@tiptap/extension-list` (TaskList/TaskItem now live here in v3) |
| Code block, language picker, syntax highlighting, copy button, wrap toggle, caption | must | `@tiptap/extension-code-block-lowlight` + `lowlight` `common` grammars (~35 languages, not `all`); disable StarterKit's built-in codeBlock to avoid duplicate-node errors |
| Simple resizable table | must | `@tiptap/extension-table` (Table/Row/Cell/Header or `TableKit`), `resizable: true` |
| Callout block (tinted bg + icon, palette: info/warning/tip/definition) | must | custom Node, `content: 'block+'` |
| Toggle block + toggle heading (collapsible) | must | `@tiptap/extension-details` + `-details-summary`/`-details-content`, one configurable node for both variants |
| Inline + block math/LaTeX (KaTeX) | must | `@tiptap/extension-mathematics`; non-negotiable for discrete maths / complexity / automata content |
| Table of contents (pane + `/toc` block) | must | derived live from heading nodes via `doc.descendants()`, no persistence needed |
| Image block | must | insertion/rendering only; upload logic is app code, reused by the photo-capture flow |
| Slash command menu (`/`) | must | hand-built `Extension` on `@tiptap/suggestion`, Floating UI popup (v3-native, not tippy.js), fuzzy filter, arrow-key nav, `minQueryLength`/`debounce` |
| Markdown input auto-convert (`# `, `- `, `1. `, `[] `, `> `, `**`, `*`, `` ` ``, `~~`) | must | StarterKit ships most as `inputRules`; wire `[] ` → TaskItem explicitly; must fire only at true line-start |
| Stable per-block IDs | must | unique-id extension on every top-level node; build this in before flashcard/comment anchoring, not after |
| Core keyboard shortcuts | must | see §5.1 |
| Bubble/floating selection toolbar (formatting + Ask AI entry) | must | `@tiptap/react/menus` + `@floating-ui/dom` (v3 moved off tippy.js) |
| Find & replace (Ctrl/Cmd+F / +H) with match count + next/prev | must | decoration-based ProseMirror plugin, not DOM string search; must survive bold/italic node boundaries |
| Live word/character count, selection-subset recompute | must | derived on the same debounce as the outline pane |
| Drag handle + hover chrome (⋮⋮, +, block menu) | should | `tiptap-extension-global-drag-handle` / `@tiptap/extension-drag-handle-react`; hand-roll the blue drop-indicator line and column-drop logic |
| Turn into (convert block type, preserve children) | should | ProseMirror transaction re-wrapping content; nested-content pairs need explicit per-type handling |
| Multi-block select + bulk action bar | should | `NodeSelection`/custom multi-node selection plugin |
| Columns / side-by-side layout (2-4 way) | should | `columnList`/`column` node pair; also the substrate for an optional built-in Cornell-style template |
| Inline + block color/highlight, fixed palette | should | `@tiptap/extension-text-style`+`-color` for text, `@tiptap/extension-highlight` for background |
| Templates: page templates + template button block | must | `templates` table storing TipTap JSON fragments; template button deep-clones + inserts on click. Directly kills the "blank lecture page" problem every single class |
| Synced blocks | could | v2: real but narrower single-user use case (shared syllabus/checklist block) |

### 4.2 Organization & Navigation

| Feature | Priority | Notes |
|---|---|---|
| Notebook sidebar tree (counts, last activity) | must | |
| Pinned/starred notes shelf, drag-reorderable | must | `pinned` + a `star_order`-style ordering; separate from the notebook tree |
| Wikilinks `[[ ]]` with fuzzy autocomplete, create-on-demand, piped display text, unresolved-link styling | must | `@tiptap/suggestion` popup on `[[`; ranking = prefix match > recency > backlink count |
| Backlinks pane (grouped by source note, ~150-char context snippet) | must | snippet captured at save time, not re-scanned on render |
| Unlinked mentions (case-insensitive plain-text title hits not yet linked) + one-click Link fix | must | scan on backlinks-pane render, not per keystroke; fine at student-vault scale (hundreds of notes) |
| Tags with `#` autocomplete, nested tags (`cs201/dp`), tag browser pane with counts | must | store full string, split on `/` only at render time |
| Quick switcher (Ctrl/Cmd+K): note-title-only fuzzy finder | must | strictly separate keybind + ranking logic from the command palette; global keydown listener |
| Command palette (Ctrl/Cmd+P): fuzzy action finder | must | single client-side command registry every new feature registers into |
| Per-note outline pane | must | see 4.1 TOC |
| Home dashboard: Timeline + Week view + per-notebook "Last time in [Notebook]" recall card + stats + activity heatmap | must | Timeline = reverse-chron cross-notebook feed; Week view = Mon-Sun grid of logged activity; recall card = last session note by `(notebook_id, updated_at DESC)` plus up to 3 cue/definition spans as a mini self-test |
| Weekly review checklist (computed, not templated) | should | pure aggregation query: notes missing a summary, un-run self-tests, overdue flashcards, unresolved comments |
| Local graph view (current note ± N hops, force-directed) | should | small Express BFS endpoint over `links`, not shipped-whole-graph-to-client; `react-force-graph`/`d3-force` |
| Exam/topic coverage tracker | should | student-entered topic rows per notebook, 3-state self-rating, linked flashcard due-count |

### 4.3 Search

| Feature | Priority | Notes |
|---|---|---|
| FTS5 full-text search (external-content table + sync triggers), bm25-ranked, highlighted snippets | must | `bm25()` is inverted: lower score = better match, `ORDER BY` ascending |
| Search operators: `"exact phrase"`, `-exclude`, `tag:#name`, `notebook:name`, implicit AND | must | thin query-parser strips recognized operators into SQL WHERE clauses, passes remaining free text to `MATCH` |
| Search-as-you-type (prefix match on trailing token) | should | |
| Advanced operators (`line:`, `block:`, `section:`, `/regex/`, `OR`/grouping) | could | regex bypasses FTS entirely via a registered `REGEXP` custom SQLite function |

### 4.4 Capture & Import

| Feature | Priority | Notes |
|---|---|---|
| Phone camera capture via `<input type="file" accept="image/*" capture="environment">` | must | **not** `getUserMedia`: LAN pairing serves plain HTTP, which is not a secure context; `capture` has no such restriction |
| QR LAN pairing page (`/pair`) | must | `qrcode` npm package; LAN IPv4 via `os.networkInterfaces()`, regenerated every server start (DHCP lease can change) |
| Vision-OCR handwritten notes pipeline | must | client-side downscale (~1600px long edge, JPEG ~0.8) before upload; server POSTs base64 data URL to the gateway's vision model at `detail: 'high'`; original photo stays pinned beside an editable transcription, never destructive one-shot OCR; tap a transcribed line → best-effort highlight of the source region; "scan next page" keeps one session note open across a whole lecture; visible "transcribing…" skeleton, async per-photo so page 2 isn't blocked on page 1 |
| Math/diagram-aware capture toggle | should | switches the vision prompt to prioritize structural fidelity (LaTeX equations, best-effort diagram description) over prose fluency |
| PDF slide import → one image + real searchable/selectable text block per slide | must | `unpdf`'s `extractText`/`getDocumentProxy`; explicitly NOT a static embedded viewer (the #1 cited OneNote/Notion complaint); student types directly beneath any slide; per-slide collapse toggle |
| PPTX import | must | `officeparser.parseOfficeAsync(..., { ignoreNotes: true })`, mapped into the same per-slide block structure |
| Transcript import (.txt/.md/.pdf), modes: new / append / improve-merge | must | server-side Markdown → TipTap JSON conversion so imports open natively, not as pasted text |
| General image upload/embed (independent of OCR) | must | |
| Post-lecture voice-memo reflection | could | v2; reuses whatever audio-upload plumbing exists by then |

### 4.5 AI Features

See §6 for exact prompt strategies. All calls: pinned models + fallback list, never `'auto'`; 502 with attempt detail on total failure; tolerate up to ~90s with a visible loading state.

| Feature | Priority |
|---|---|
| Ask-your-notes RAG Q&A with citations | must |
| Improve writing / grammar / tone (accept-reject preview, never silent overwrite) | must |
| Summarize block/section/page | must |
| Extract flashcards (human-approved before insert) | must |
| Auto-generate note title | must |
| Extract action items → real to-do blocks | should |
| AI-suggested cues + summary in a review/approve panel, auto-triggered after photo transcription | should |
| On-demand grammar & style pass (accept/reject tracked changes) | should |
| Translate selection | could |
| AI-generated page icons | could: blocked on the gateway exposing image generation; verify before scoping |

### 4.6 Flashcards & Spaced Repetition

| Feature | Priority | Notes |
|---|---|---|
| Inline "select text → flashcard" creation, live-linked to source block + anchor text | must | RemNote-pattern: editing the source note later re-anchors via fuzzy text-diff rather than silently breaking the link; chain-link icon on already-carded text |
| SM-2-lite engine | must | pure function: quality-in → `{interval, ease, reps}`-out; ~20 lines, hand-rolled and unit-tested, not a library; keep the interface swappable for a future FSRS upgrade |
| Cross-notebook daily due queue (not per-notebook) | must | supports interleaved practice, which research shows beats blocked single-subject cramming |
| Full-screen distraction-free review flow (reveal → 4-button grade → auto-advance) | must | |
| Cue-column self-test mode inside a session note | should | hide/reveal per cue, "review again" → one-click flashcard conversion |
| Exam/topic coverage tracker | should | see 4.2 |
| Interleaved cross-module "Exam mode" (auto-banner near exam dates, shuffled queue) | could | v2 |

### 4.7 Version History

| Feature | Priority | Notes |
|---|---|---|
| Debounced autosave + 3-state indicator (Saving.../Saved <relative time>/error+retry) | must | client-side buffer (IndexedDB/localStorage) survives a crashed/unreachable Express process; `beforeunload` guard if the last save hasn't confirmed. This is the trust foundation everything else sits on |
| Auto-snapshot checkpoints, retention-pruned when unnamed | must | full snapshots, not deltas: cheap at document scale |
| Named version checkpoints ("Save a version as…"), never auto-pruned | must | just an `is_named`/`label` flag on the same table |
| Non-destructive restore (read-only preview, restore = new version, nothing destroyed) | must | |
| Version diff/compare view | could | v2: needs a real text-diff algorithm over doc-JSON extraction |

### 4.8 Comments & Margin Notes

| Feature | Priority | Notes |
|---|---|---|
| Text-range-anchored margin notes (mark-based `commentId`, survives edits before/after) | should | reference pattern: TipTap's official Comments extension approach, mark-based not raw-offset-based |
| Resolved/unresolved toggle, per-note margin indicator, cross-note "open notes" list | should | |
| Essay draft note type with parallel tutor-feedback layer | could | v2; reuses the same photo-capture vision pipeline for scanned marked scripts |

### 4.9 Export

| Feature | Priority | Notes |
|---|---|---|
| Markdown export | must | the credibility proof notes aren't locked in a proprietary SQLite blob |
| PDF export | should | browser print stylesheet (`window.print()`), zero new dependency |
| DOCX export | should | `docx` npm package walking ProseMirror JSON, no external binary (Pandoc/LibreOffice) needed |

### 4.10 Mobile & LAN Pairing

| Feature | Priority | Notes |
|---|---|---|
| Responsive editor + dashboard for phone width | must | |
| QR pairing flow, verified from a real phone on the same Wi-Fi | must | |
| Touch target sizing (≥44px) for all mobile-reachable actions | must | |

### 4.11 Settings & Personalization

| Feature | Priority | Notes |
|---|---|---|
| Light default theme, full dark-mode parity toggle | must | no component ships unstyled in either mode |
| Native contentEditable spellcheck + personal dictionary | must | zero backend cost; dictionary persisted in `settings`/a small word table so CS jargon (Dijkstra, kubectl, async) isn't flagged every time |
| Full-width / small-text page display toggle | could | v2 cosmetic |

---

## 5. UX Details

### 5.1 Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Bold / Italic / Underline / Strikethrough / Inline code | Ctrl/Cmd+B / I / U / Shift+S / E |
| Add link | Ctrl/Cmd+K |
| Turn block into paragraph/H1/H2/H3/to-do/bullet/number/toggle/code | Ctrl/Cmd+Shift+0-9 (Cmd+Opt+0-9 on Mac) |
| Indent / un-indent list item | Tab / Shift+Tab |
| Duplicate block | Ctrl/Cmd+D |
| Move block up/down | Ctrl/Cmd+Shift+Up/Down |
| Delete empty/selected block | Backspace |
| Select block as object | Esc |
| Turn into picker | Ctrl/Cmd+/ |
| Find in note / Find & replace | Ctrl/Cmd+F / Ctrl/Cmd+H |
| Quick switcher (find a note) | Ctrl/Cmd+K |
| Command palette (run an action) | Ctrl/Cmd+P |
| Save named version | Ctrl/Cmd+Alt+S |
| Create flashcard from selection | Ctrl/Cmd+L |
| Comment on selection | Ctrl/Cmd+Shift+M |
| Ask AI on selection | (bubble menu button; no default global bind to avoid collisions) |
| Insert block | `/` |
| Wikilink | `[[` |
| Tag | `#` |

Quick switcher and command palette are deliberately never the same keybind or ranking logic. Students should be able to trust Ctrl/Cmd+K always means "find a note" without ever accidentally firing a command.

### 5.2 Empty States

- **Empty notebook**: illustration + "No notes yet in [Notebook]" + primary button "New session note" (opens the template picker, not a blank page) + secondary "New blank note".
- **Empty note**: cursor placed in the title, greyed placeholder body text reading "Type '/' for commands, or just start writing…".
- **Empty search results**: "No matches for '{query}'" + a hint listing the operators (`tag:`, `notebook:`, `"phrase"`, `-exclude`).
- **Empty backlinks pane**: "Nothing links here yet. Link a note with [[{this note's title}]] to see it appear."
- **Empty flashcard queue**: celebratory state ("You're all caught up (0 due)") rather than a blank list, with a link to "Add flashcards from your notes".
- **Empty dashboard (brand-new install)**: onboarding card reading "Add your first notebook", with a one-field emoji+name form, seeded suggestion chips (e.g. common CS module names) to remove blank-canvas hesitation.
- **Empty Ask-my-notes corpus**: "You haven't written any notes yet. Unote answers from what you've written, so there's nothing to draw on. Take a few notes first." (never a raw error).

### 5.3 Loading & Save States

- **Autosave chip** (near the note title): cycles Saving… (grey, mid-debounce) → Saved · 8s ago (checkmark, settles + updates its relative time on a tick) → Can't save, retrying (red, on unreachable server); this is the single most load-bearing piece of trust UI in the app.
- **AI actions**: every AI call shows a distinct "thinking" state inline at the point of action (not a generic global spinner): e.g. the improve-writing bubble shows a shimmer over the selected text; summarize shows a skeleton paragraph where the summary will land; Ask-my-notes shows a streaming-style token reveal if the gateway supports streaming, else a bouncing-dot "Reading your notes…" for calls that can run up to 90s.
- **Photo-capture transcription**: skeleton text block under the pinned photo thumbnail reading "Transcribing…", replaced in place once the vision call resolves; "Scan next page" stays enabled immediately so capture isn't blocked on transcription.
- **Import jobs** (PDF/PPTX/transcript): a persistent job-status toast with step text ("Extracting text…" → "Restructuring into notes…" → "Done") since these can run for several seconds on a multi-slide deck.
- **Search**: results update on debounce (~150ms) with a subtle skeleton-row placeholder only if a query takes >250ms to resolve. Most FTS5 queries at student-vault scale will beat that and should never show a spinner at all.

### 5.4 Visual Design Language

Light, Notion-adjacent: generous whitespace, a restrained fixed color palette (gray/brown/orange/yellow/green/blue/purple/pink/red, each with a text and a background variant) reused consistently for callouts, tags, and highlights so color always carries the same "meaning" across the app (e.g. yellow-highlight = flagged-for-exam). Hover-only chrome (drag handle, +, block menu) keeps the canvas clean until the student asks for it. Dark mode is a first-class second pass, not an inverted-filter afterthought: every custom node (callout, toggle, table, code block, math) gets an explicit dark-mode style.

---

## 6. AI Prompt Strategies

All calls go through `ai/client.ts`'s `chat()` helper against the local OpenAI-compatible gateway, iterating a pinned model list on failure. Prompts live in `ai/prompts.ts` as exported functions.

**`POST /api/ai/improve`** system prompt: *"You are an exacting writing editor for a university student's notes. Rewrite the given text according to the instruction below. Preserve factual content and technical terms exactly; never invent or drop information. Preserve the original Markdown structure (headings, lists, code blocks) unless the instruction asks otherwise. Output ONLY the rewritten Markdown, no preamble, no explanation."* User content = instruction (default: "Improve clarity and flow") + the selected text or the note's `content_text`. Response is rendered as an accept/reject/try-again diff preview, never auto-applied.

**`POST /api/ai/summarize`** system prompt: *"Summarize the following lecture/revision notes for a student revising for an exam. Output: a 2-4 sentence TL;DR, then a 'Key points' bulleted list (max 8), then a 'Key terms' list of important vocabulary with a one-line definition each. Be faithful to the source; do not add information that isn't in the notes. Output Markdown only."* Scoped to either a selected block/toggle or the whole page's plain-text extraction.

**`POST /api/ai/flashcards`** system prompt: *"Read the following notes and generate {count} flashcards for spaced-repetition study. Each card must test ONE atomic fact, definition, or concept, not a whole paragraph. Prefer questions that require recall, not recognition (avoid true/false or multiple choice phrasing). Return ONLY a JSON array of objects: [{\"question\": string, \"answer\": string}]. No markdown fencing, no commentary."* Response is parsed as JSON and mapped directly into flashcard rows, shown in a review panel (edit/delete/reorder) before the student confirms insert, never silently committed.

**`POST /api/ai/ask`** RAG pattern: extract keywords from the question, run an FTS5 query for the top 6 matching notes, build the prompt as: *"You are answering a student's question using ONLY the notes provided below. Cite which note each part of your answer comes from using the exact note title in square brackets, e.g. [Big-O Notation]. If the notes don't contain enough information to answer, say so explicitly rather than guessing or using outside knowledge.\n\n--- NOTES ---\n{title}: {content}\n...\n--- QUESTION ---\n{question}"*. Response `answer` (markdown) ships alongside a `sources: [{id, title}]` array the client resolves into clickable deep links. Empty corpus short-circuits to a helpful message before ever calling the gateway.

**`POST /api/ai/title`** system prompt: *"Generate a short, specific title (max 60 characters, no quotation marks, no trailing punctuation) for the following note content. Prefer the actual topic/lecture name over generic phrasing like 'Notes' or 'Untitled'."*

**Vision-OCR photo transcription** is sent as a `chat/completions` call with an `image_url` content part (base64 data URL, `detail: 'high'`). System/user prompt: *"Transcribe this photo of handwritten student notes into clean Markdown. Rules: (1) Read carefully: cross-reference surrounding context to resolve ambiguous or messy handwriting rather than guessing wildly. (2) Preserve the student's structure: headings become '#'/'##', bullet or dash lists become Markdown lists, underlined or circled terms become **bold**. (3) If 'math mode' is on, render any equations as LaTeX wrapped in $$ ... $$ (inline) or a fenced math block (display), prioritizing structural fidelity over prose fluency; describe simple labelled diagrams in one sentence below the relevant section rather than dropping them. (4) Output ONLY the Markdown transcription, no preamble like 'Here is the transcription:', no closing remarks."* Also returns 3-5 candidate cue questions in a structured trailing JSON block for the should-tier auto-suggested-cues panel. Express body-limit must be raised (`express.json({ limit: '20mb' })`). The default 100kb silently 413s every phone photo.

**PDF slide restructuring**. After `unpdf` extracts raw per-page text, an AI pass reorganizes it: *"The following is raw extracted text from lecture slides, in slide order. Group and lightly restructure it into a clean set of topical sections (not one heading per slide if adjacent slides are clearly one topic). Preserve all technical content verbatim; do not summarize or drop detail. Output Markdown with '##' section headings."* Used only for the optional "restructure into a lecture outline" mode; the default per-slide block import (must-tier) keeps a literal 1:1 slide→block mapping with no AI involved, so the raw source is always available even if the AI restructuring pass is skipped or fails.

---

## 7. API Surface (reference)

Full contract lives in `docs/API.md` (authoritative for implementation). Route files: `notebooks.ts`, `notes.ts`, `search.ts`, `tags.ts`, `dashboard.ts`, `ai.ts`, `imports.ts`, `study.ts`, `meta.ts`. This spec adds two implied additions to that contract for the should-tier comments feature: `GET /api/notes/:id/comments`, `POST /api/notes/:id/comments`, `PATCH /api/comments/:id` (resolve/edit), following the same JSON conventions (camelCase, `{ error }` on failure, ISO-8601 timestamps).

---

## 8. Quality Bar: Definition of Done

A feature is **done**, not just working, when:

1. **No data loss is possible under normal failure.** Autosave buffers survive a killed Express process; a crashed AI call never leaves a note half-overwritten (AI writes always go through the accept/reject preview, never a direct patch); every restore and every AI rewrite snapshots a version first (`cause: 'restore'`/`'ai'`).
2. **Every AI/import endpoint fails gracefully.** No unhandled 500s reach the client; total-model-failure returns a typed `502 { error, attempts }`; the UI has a specific, human-readable fallback for each failure mode, not a generic toast.
3. **FTS5 stays in sync.** Insert/update/delete triggers are covered by a test that writes a note, searches for a unique token, edits the note to remove that token, and confirms the old search now returns nothing.
4. **The SM-2 engine is a pure, independently unit-tested function** (quality-in → `{interval, ease, reps}`-out), verified against known reference sequences (e.g. all-Good ratings produce 1→6→~15 day intervals), decoupled from any UI or HTTP code.
5. **Dark mode has zero unstyled surfaces.** Every custom TipTap node (callout, toggle, table, code block, math, columns) and every app chrome element (sidebar, dashboard, dialogs) is checked in both themes before a feature is called complete.
6. **Mobile/LAN capture is verified on a real phone**, not just Chrome DevTools' device emulator. The QR pairing flow, the camera `capture` input, and the upload round-trip must be exercised from an actual device on the same Wi-Fi at least once per milestone that touches the capture pipeline.
7. **Keyboard-only operation works for the core loop**: create a note, insert every must-tier block type via `/`, format text, create a wikilink, open the quick switcher, review a flashcard. All reachable without a mouse.
8. **Search and quick switcher respond within ~150ms** at student-vault scale (hundreds of notes) with no visible loading flicker for the common case.
9. **Every should-tier and must-tier item in this spec has a corresponding Playwright e2e test** covering its primary happy path, plus at least one server-side test for any new SQL (schema migration, trigger, cascade).
10. **Exports round-trip credibly.** A Markdown export of a note containing headings, lists, code, and a table re-imports (or is manually verifiable) as recognizably the same content: this is the proof point that backs the "not locked in a proprietary blob" claim.
11. **The single-user/no-auth decision is documented, not silent.** The README/settings page states plainly that Unote is intended for trusted local-network use only and is not hardened against untrusted network access.
