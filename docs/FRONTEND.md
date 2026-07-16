# Folio frontend contract

Authoritative for the web/ workspace. React 18 + Vite + TS + react-router-dom v7 (data router already wired in `src/main.tsx` — do not change routes, only fill pages in). TipTap v3.28 installed. API client: `src/lib/api.ts` (complete, typed — use it, never raw fetch).

## Design direction (light, Notion-like, premium)
- **Feel:** calm, paper-like, precise. Generous whitespace, small type scale, subtle borders (not shadows) for structure. Nothing bootstrap-y. Dark mode via `[data-theme="dark"]` on `<html>`, toggle persisted in localStorage (`folio:theme`), respects `prefers-color-scheme` on first run.
- **Type:** `Inter Variable` (install `@fontsource-variable/inter`) with system-ui fallback; editor body 16px/1.7; UI chrome 13–14px; note title 40px/700 borderless input. Code: `ui-monospace, 'Cascadia Code', Consolas`.
- **Tokens** live in `src/styles/tokens.css` as CSS variables — ALL components use them, zero hard-coded colors elsewhere:
  - Light: `--bg: #ffffff; --bg-sidebar: #f7f7f5; --bg-hover: #f1f1ef; --bg-active: #eaeae8; --ink: #1f2328; --ink-2: #57606a; --ink-3: #8b949e; --line: #e8e8e6; --accent: #4f46e5; --accent-soft: #eef2ff; --danger: #d1242f; --ok: #1a7f37; --warn: #9a6700; --radius: 8px; --radius-lg: 12px; --shadow-pop: 0 8px 30px rgba(0,0,0,.12);`
  - Dark equivalents: bg #191919, sidebar #202020, ink #e6e6e4, line #303030, hover #252525, accent #818cf8, accent-soft rgba(129,140,248,.14).
- Notebook colors come from the notebook record (`notebook.color`); use for dots/accents, never for large fills.
- Micro-interactions: 120–160ms ease-out transitions on hover/open; skeleton shimmer for loading; every async action has a pending state; toasts bottom-right (`components/Toast.tsx` exposes `toast(msg, kind)`).
- Empty states: friendly, specific, with a primary action (e.g. "No notes in this notebook yet — ⌘ New note or 📷 Import from photo").

## Layout
Desktop shell (`App.tsx`): left sidebar 260px (collapsible to 0 with animation, state in localStorage) + main content. Sidebar: Folio wordmark, Search button (opens quick switcher, shows ⌘K hint), Home, Study (with due-count badge), Ask AI, divider, notebook list (emoji + name + count, active state, hover reveals ⋯ menu: rename/emoji/color/archive/delete), + New notebook, footer: theme toggle, phone-capture QR button, AI status dot (green/red from `api.aiHealth()`).
Responsive: <900px sidebar becomes an overlay drawer with hamburger. The app must be fully usable at 390px width.

## Keyboard shortcuts (global hook `lib/useShortcuts.ts`)
- `Ctrl/Cmd+K` quick switcher (search titles as you type, ↑↓ navigate, Enter open, shows notebook + relative time; falls through to full-text results below title matches)
- `Ctrl/Cmd+N` new note in current notebook (or first notebook)
- `Ctrl/Cmd+Shift+F` focus full search page/panel
- `Esc` closes any modal/palette
Show hints in tooltips ("Search ⌘K").

## Route → file ownership (agents replace placeholder files; NEVER edit another agent's files)
| Route | File | Owner |
|---|---|---|
| shell | `src/App.tsx`, `src/styles/*`, `src/components/*`, `src/lib/useShortcuts.ts`, `src/lib/theme.ts`, `src/lib/format.ts` | **web-shell** |
| `/` | `src/pages/DashboardPage.tsx` | **web-shell** |
| `/notebook/:notebookId` | `src/pages/NotebookPage.tsx` | **web-shell** |
| `/note/:noteId` | `src/features/editor/**` | **web-editor** |
| `/study` | `src/features/study/**` | **web-study-import** |
| `/ask` | `src/features/ask/**` | **web-study-import** |
| `/capture` | `src/features/import/**` | **web-study-import** |

Shared primitives owned by web-shell that others import (fixed paths + props, keep them dumb):
- `components/Modal.tsx` `{ open, onClose, title?, width?, children }`
- `components/Toast.tsx` → export `toast(message: string, kind?: 'ok'|'error'|'info')` + `<Toaster/>` (mounted in App)
- `components/EmptyState.tsx` `{ icon, title, hint?, action? }`
- `components/Spinner.tsx`, `components/Skeleton.tsx` `{ lines? }`
- `components/NoteCard.tsx` `{ note: NoteLite, onClick }` — used by dashboard/notebook/search lists

Cross-feature contract: **web-study-import** exports `ImportModal` from `src/features/import/ImportModal.tsx` with props `{ open, onClose, notebookId?, noteId?, defaultKind?: 'photo'|'slides'|'transcript' }`; web-shell renders it from sidebar button + notebook page "Import" button; web-editor opens it with `noteId` for append/improve. Import completion navigates to the new/updated note.

## Page specs
**Dashboard `/`** — "Good afternoon" header with date; "Continue where you left off" hero card (last edited note: title, notebook chip, snippet, relative time); Recent lessons grid (NoteCard × 8, newest first — THE core 'see last lessons' surface); Pinned strip; per-notebook columns row; right rail: study widget (cards due → Start review), 14-day activity mini-heatmap, stats line (n notes · n words). All data from `api.dashboard()` in one call.

**Notebook page** — header: emoji + name (inline editable), note count, sort select (updated/created/title), actions: New note, Import ▾ (photo/slides/transcript). Note list: rows with title, snippet, tags, relative updated time, pin toggle, ⋯ menu (pin/duplicate→create copy/move notebook/archive/delete with confirm). Tag filter chips (from notes' tags). Archived section collapsed at bottom.

**Editor page `/note/:noteId`** (web-editor) — the crown jewel. Breadcrumb (notebook › note), autosave state ("Saving…" → "Saved · 2m ago" with cloud check), actions bar: Pin, AI ▾ (Improve writing, Summarize, Generate flashcards, Suggest title), Import into this note ▾, History, Export Markdown, Info (word count, backlinks count).
- Borderless title input (placeholder "Untitled"); Enter moves to body.
- TipTap v3: StarterKit (includes Link/Underline) + Placeholder('Type \'/\' for commands…') + TaskList/TaskItem + Table (resizable) + Image + Highlight + Typography + CodeBlockLowlight(lowlight, common languages).
- **Slash menu** (`@tiptap/suggestion` on `/`): Text, H1 H2 H3, Bullet list, Numbered list, To-do list, Toggle? (skip if not native — do NOT fake it), Quote, Divider, Code block, Table, Image (file picker → `api.uploadImage`), Callout (custom node: div with emoji + tinted bg, colors info/warn/ok). Fuzzy filter, ↑↓+Enter, mouse hover, esc closes. Icons + short descriptions, Notion-style floating panel.
- **Markdown input rules** come free with StarterKit (`# `, `- `, `1. `, `> `, ``` etc.) — verify `[]` todo shortcut works via TaskItem.
- **Bubble menu** on text selection: Bold, Italic, Strikethrough, Code, Highlight, Link (small input popover), and "AI edit" (sends selection to `api.aiImprove({text, instruction})` with quick instructions: Improve / Shorten / Expand / Fix grammar → preview diff panel → Replace/Insert below/Discard).
- **Wikilinks**: typing `[[` opens the same suggestion machinery listing note titles (search-as-you-type via `api.searchTitles`); selecting inserts a link node/mark navigating to `/note/:id`, styled accent with hover preview card (title + snippet). Store as plain `[[Title]]` text in contentText for server extraction (serialize the node's text form accordingly).
- **Autosave**: debounce 800ms after last change; PATCH title/contentJson/contentText (`editor.getText()` but ensure wikilinks serialize as `[[Title]]`); optimistic 'Saving…' indicator; on error toast + retry backoff; flush on blur/unmount/beforeunload.
- **Backlinks section** below editor: "Linked from n notes" cards + "Unlinked mentions" with per-row "Link" action hint (open note). 
- **History panel** (right drawer): version list grouped by day (cause icons: ✍️ autosave, 📌 manual, ✨ AI, ⏪ restore, 📥 import), click → read-only preview in the drawer with Restore + named snapshot button at top ("Snapshot now" with optional label).
- **AI actions**: run via api, show progress ("Thinking…" with model name), result in preview modal (rendered markdown via `marked` + sanitize) with Apply (Improve → replaces body after auto-snapshot; Summarize → inserts "## Summary" callout at top; Flashcards → toast "8 cards added" linking /study; Title → sets title). Handle 502 gracefully: "AI offline — is the gateway running?" toast.

**Study `/study`** — review screen: card counter (m due), question card (large, centered), "Show answer" (Space), rating buttons Again/Hard/Good/Easy (1/2/3/4 keys) with next-interval hints ("<10m", "1d", "3d"…), progress bar, session summary at end (n reviewed, streak). Browse tab: table of all cards (question, note, due, reps) with edit/suspend/delete. Empty state → "Generate flashcards from a note" pointing at editor AI menu.

**Ask `/ask`** — chat-ish single page: big input "Ask your notes…", optional notebook filter chips, answer rendered as markdown with sources footer (chips linking to notes); history of Q&A pairs this session (in-memory); loading shimmer; each answer has "Insert into new note" action.

**Capture `/capture`** (mobile-first, standalone page, no sidebar): big camera button (`<input type="file" accept="image/*" capture="environment">`), notebook select, kind toggle (Photo of notes / Slides PDF / Transcript), after pick → preview + "Upload & process" → job progress (poll `api.importJob`) with step labels ("Extracting text…", "Improving notes…") → success screen with note title + "Open on desktop" hint. Also file drop zone for desktop use. QR from sidebar (`api.qr()`) points phones here (`http://LAN-IP:4780/capture` — note: served single-port from Express static build; dev testing via Vite is fine too).

**ImportModal** (desktop) — 3 kind tabs, drag-drop + file picker, notebook select (or fixed noteId mode showing target note + mode radio append/improve), upload → inline progress (same job polling), done → "Open note" button + auto-navigate. Validation: type/size errors shown inline.

## Quality bar (what 'done' means)
- No console errors; no unhandled promise rejections; every fetch failure surfaces a toast, never a blank screen.
- Every list has loading skeleton + empty state + error state.
- Relative times ("2m ago", "yesterday") via `lib/format.ts` helper (no dep needed).
- Keyboard accessible: palette, menus, modals (focus trap, Esc, aria labels on icon buttons).
- Feels instant: optimistic updates for pin/archive/delete with rollback on error.
