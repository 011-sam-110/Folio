# Iteration 1 — fix wave summary

Response to the five-critic review of green v1 (findings: `docs/reviews/iter1-findings.json`).
Scope: all triaged criticals + surgical majors. The big deferred subsystems (command palette,
templates, search page/operators, tag browser, margin comments, columns, dashboard week-view,
manual flashcard anchors, block menu, find/replace, settings, graph view) are iteration 2.

## Editor data integrity (web-bughunt criticals)

**#1 Note-load race** — `NotePage.tsx` now guards its load with a monotonic request id
(`loadSeq`); only the latest navigation may commit its response, and the id is invalidated on
unmount/param change. A stale GET resolving late can no longer swap the editor to a different
note's content (root cause of the caret-jump-to-start bug). e2e: `fixes.spec.ts` delays one
note's GET and asserts the fresh note survives.

**#2 Failed autosave cleared the dirty flag** — `useAutosave.ts` rewritten: the dirty flag is
only cleared after a confirmed 2xx AND only if no edit landed mid-flight (monotonic edit
counter). Failures keep the note dirty (so unmount/beforeunload still retry), auto-retry with
2s→30s capped backoff, and the chip keeps its saving/saved/error+Retry states. e2e: route
interception forces PATCH 500s, asserts 'Save failed' chip, then auto-recovery + persistence.

**#3 flush() dropped newest edits when a save was in flight** — a flush arriving mid-save now
chains a follow-up save (bound to the fresh payload) instead of returning the older save's
promise. 'Saved' can no longer lie about content the server doesn't have.

**#4 Restore / import-into-open-note never refreshed the live editor** — `NoteWorkspace` gains
`resyncFromServer()`: waits for any in-flight save (`autosave.settle()`), kills pending/failed
saves (`markClean()`), refetches the note, `setContent`s the live editor, and re-seeds the
autosave snapshot. Wired to `HistoryPanel.onRestored` and a new `ImportModal.onImported`
callback (fires when an import's result note is the open note). e2e: restore, then type, then
reload — the post-restore autosave persists the restored doc, not the stale one.

## Server correctness (server-bughunt)

**#5 Concurrent imports lost data** — append/improve writes are serialized per note
(`withNoteLock`, a per-note promise chain) and each write re-reads fresh content inside a
`db.transaction`. The async AI step happens BEFORE the transaction re-read; if the note changed
during the AI call, improve degrades to a non-destructive append instead of overwriting.
Unit test: 5 concurrent appends all persist.

**#6 Second wikilink extractor dropped `[[Title|Alias]]`** — deleted from `imports.ts`; all
paths now use `lib/links.ts::syncLinksForNote` (alias-aware). Also fixed
`markdownToPlainText` collapsing `[[Title|Alias]]` to `[[Title]]` BEFORE table-pipe stripping
corrupted it. Unit test: aliased link via the append path resolves.

**#7 Rename orphaned backlinks** — on title change, `renameWikilinksToTitle` rewrites
`[[oldTitle]]`/`[[oldTitle|alias]]` in every referencing live note (content_text + wikilink
nodes in content_json), re-resolves their links, and does NOT bump their updated_at.
Documented in API.md; unit tested.

**#8 contentJson validation** — POST/PATCH notes reject anything that isn't
`{ type: 'doc', content: [...] }` with 400. A bricked note is impossible. Unit tested.

**#9 UTC day boundaries** — `reviewedToday` (study stats) and the dashboard 14-day
`weekActivity` now bucket by the server machine's LOCAL day. Unit tested; documented.

**#10 CORS wide open** — origin callback now allows only localhost + private-LAN
(10.*, 192.168.*, 172.16-31.*, *.local) http(s) origins, plus `FOLIO_CORS_ORIGINS` extras;
no-Origin requests pass. A third-party website can no longer cross-origin fetch the LAN API.

**#11 AI size guard** — `capForAi()` truncates note content at ~24k chars (8k for titles)
with a `[truncated]` marker, applied to improve/summarize/flashcards/title and the import
merge prompt (/ask already sliced). Unit tested.

**#12 SM-2** — a new card rated 'hard' twice consecutively now graduates to a 1-day interval
(escapes the 10-minute relearn loop; detected via the last review_log entry); ease is capped
at 3.0. API.md updated; unit tested both.

**#13 Soft-delete** — `deleted_at` column (idempotent ALTER migration in db.ts + schema for
fresh DBs). DELETE sets it; every read path (lists, recent, search, titles, tags, dashboard,
notebook counts, AI retrieval, unlinked mentions, import targets, link resolution) excludes
deleted notes; `POST /api/notes/:id/undelete` restores within the window and re-links both
directions; rows deleted >30 days are purged on boot. Web: note delete shows a 10s Undo toast
(new `toast(..., { action })` support); notebook delete stays hard but requires typing the
notebook name (`ConfirmDialog.requireText`). Unit + e2e tested.

## Web correctness (web-bughunt)

**#14 Context filing** — new `lib/notebookContext.ts`: route param → open note's notebook
(published by NotePage) → last-used (localStorage) → first. Used by Ctrl+N (App) and
quick-switcher create; a toast names the destination notebook. e2e: Ctrl+N from a note in the
second notebook files there, not into notebooks[0].

**#15 NotebooksContext rollback** — every mutation now captures a synchronous pre-mutation
snapshot (`latestRef` mirror updated inside setState) and rolls back to THAT; the old
useEffect-refreshed snapshot re-applied the failed optimistic state.

**#16 Modal focus trap** — the trap effect depends on `[open]` only; `onClose` is read via a
ref. ImportModal's 800ms poll re-renders no longer steal focus back every second.

**#17 Selection AI edit stale positions** — the target range is live-mapped through every
transaction (`editor.on('transaction')` + `tr.mapping`) from request start until apply/dismiss,
then clamped to the doc. Replace/Insert can no longer land at stale positions.

**#18 Mobile drawer** — closed state is `inert` + `visibility: hidden` (transition-delayed so
the slide-out still animates); open state gets a focus trap and Escape-to-close mirroring
Modal.tsx.

## Import/AI quality (student-persona)

**#19 pptx/docx end-to-end** — `kindAccepts` now accepts .pptx for slides and .docx for
transcript (extract.ts already parsed them via officeparser). Client accept lists/copy already
advertised them. New real fixtures (`slides.pptx`, `essay.docx`) built with fflate in
`e2e/fixtures/generate.ts`, verified through officeparser at generation time; e2e imports both.

**#20 /capture multi-page** — after a success the capture page offers "Add another page",
which chains the next upload as mode=append into the note just created (banner + escape hatch
"Start a new note instead"), mirroring ImportModal. e2e chains a .txt then a .docx into one
note and asserts both contents landed in the same note id.

**#21 Show originals** — GET note now returns `attachments` (kind/originalName/url/mime/size);
NotePage renders an attachment strip under the title: photo thumbnails and file chips linking
to `/uploads/...`. Unit + e2e tested.

**#22 Real wikilink + math nodes from markdown** — server `markdownToTipTap` post-processes
the generated doc: `[[Title]]`/`[[Title|Alias]]` become real wikilink nodes (noteId resolved
by title at conversion time via `resolveNoteIdByTitle`; unresolved → noteId null) and
`$...$`/`$$...$$` become inlineMath/blockMath nodes — code blocks/inline code excluded. Seed
pre-assigns note ids so seeded wikilinks resolve (forward references included). Editor:
unresolved wikilinks render in a distinct 'missing' style (muted + dashed underline) and
clicking one offers "Create note" (hover card has a create button too). Unit tested.

**#23 Duplicate title heading** — `stripLeadingTitleHeading` drops a leading body H1 that
matches the resolved title (case/whitespace/punctuation tolerant) on imported notes. Unit
tested.

**#24 Study notebook filter** — `GET /api/study/queue?notebookId=` scopes cards + due/total;
card DTO gains notebookId/notebookName. StudyPage shows filter chips on the Review tab
("Reviewing X only"). Unit + e2e tested; API.md updated.

## Design fixes (design-critic)

**#25 Dashboard mobile** — <640px: `.note-grid`/`.notebook-col-row` collapse to one column,
`.dash` gets `overflow-x: clip`, hero title/snippet get `overflow-wrap: anywhere` + 2-line
clamp, pinned-strip cards clamp to `min(230px, 78vw)`. Capture notebook picker gets an edge
fade mask as a scroll affordance.

**#26 Quick switcher garbled text** — `.folio-qs__row-title/-snippet` are spans; nowrap+
ellipsis need block boxes. `display: block` added — full-text results now elide cleanly.

**#27 --ink-3 contrast** — light `#8b949e→#6b7280` (4.83:1 on #fff), dark `#6e6e6b→#8a8a86`
(5.08:1 on #191919). Token values only.

**#28 Bubble menu placement** — explicit `flip: { fallbackPlacements: ['bottom'], padding: 8 }`
+ `shift: { padding: 8 }` so the toolbar flips below the selection instead of covering it.

**#29 Icon consistency** — all design-critic-flagged emoji in interactive chrome replaced with
the app Icon set (new icons: info, camera, file-text, download, rotate-ccw, link): editor
Pin (📌/📍→pin/pin-filled), AI buttons (✨→sparkles, NotePage + SelectionToolbar), note info
(ℹ️→info), link button (🔗→link), History cause icons (✍️📌✨⏪📥→pencil/pin/sparkles/
rotate-ccw/download), import kind tabs + drop zones + file chips in ImportModal, CapturePage
and NotePage's import menu (📷📑📝→camera/layers/file-text). Notebook emoji (user content)
untouched.

## Also fixed in passing

- `recursive_triggers = ON` pragma pinned (FTS delete-sync on notebook cascades).
- `attachments(note_id)` index.
- Soft-deleted notes excluded from wikilink title resolution and import merge targets.
