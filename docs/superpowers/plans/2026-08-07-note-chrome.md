# Note Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-note chrome legible — group twelve flat controls into three labelled zones, give every control a visible label, and collapse six competing overlays into one docked drawer.

**Architecture:** `NotePage.tsx` (925 lines) stays the state owner but sheds its two largest responsibilities into focused files: `NoteActionBar.tsx` for the toolbar and `NoteDock.tsx` for the side panels. The dock is shared infrastructure — the AI review rail from the sibling plan mounts into it as a fifth tab.

**Tech Stack:** React, TipTap, plain CSS following the existing `folio-` naming, Playwright, oxlint.

## Global Constraints

- **Never touch `web/index.html`.** sha256-pinned inline script; its hash is duplicated in `vercel.json` and `server/src/lib/csp.ts`. Editing it — even a comment — silently breaks CSP in production.
- **`web` has no unit test runner.** Do not add one. Verify with `npm run build -w web` (the typecheck: `tsc -b && vite build`), `npm run lint -w web`, and `npm run e2e`.
- **Relocate features, never delete them.** Every control removed from the action bar must reappear somewhere a user can find it.
- **Keep every existing `title` and `aria-label`.** Visible labels are added alongside them, not in place of them.
- Match the surrounding comment density — this codebase explains non-obvious decisions in prose.
- Commit after each task. Do not push. Do not open PRs.

**Spec:** `docs/superpowers/specs/2026-08-07-note-view-redesign-design.md` §2

---

### Task 1: The three-zone action bar — IN FLIGHT

**Status:** being built on branch `feat/note-action-bar` by a dispatched agent as of
2026-08-07. Do not start this task; check the branch first.

**Files:**
- Create: `web/src/features/editor/NoteActionBar.tsx`
- Modify: `web/src/features/editor/NotePage.tsx`, `web/src/features/editor/notePage.css`

Scope as briefed: three zones (Write / Panels / Note actions), every control visibly
labelled, the four-item AI menu, Assistant moved into the Panels segment, `⋯ More`
holding History + Import + Export + Pin + Info + Summarise + Suggest a title, and
`Find missing content from uploads` rendered **disabled with an honest reason** until
`POST /api/ai/gaps` exists (sibling plan, Task 5).

New state added to `NotePage`: `outlineOpen` gating `<OutlinePane>` (which currently
renders unconditionally), and a Find toggle routing to the existing `setFindMode`. The
Ctrl/Cmd+F and Ctrl/Cmd+H shortcuts keep working.

---

### Task 2: NoteDock

**Files:**
- Create: `web/src/features/editor/NoteDock.tsx`
- Create: `web/src/features/editor/noteDock.css`
- Modify: `web/src/features/editor/NotePage.tsx`
- Modify: `web/src/features/comments/CommentsPanel.tsx`, `web/src/features/editor/HistoryPanel.tsx`, `web/src/features/editor/AssistantPanel.tsx` — only to strip their own positioning/backdrop, so the dock owns layout

**Interfaces:**
- Consumes: nothing from Task 1 beyond the toggle state it already owns
- Produces:
```ts
export type DockTab = 'history' | 'comments' | 'assistant' | 'ai-review';

export interface NoteDockProps {
  open: DockTab | null;
  onOpenChange: (tab: DockTab | null) => void;
  badges?: Partial<Record<DockTab, number>>;   // e.g. { comments: 2 }
  children: Partial<Record<DockTab, React.ReactNode>>;
}

export default function NoteDock(props: NoteDockProps): JSX.Element | null;
```

**One panel open at a time.** Today History, Comments, Assistant, Outline, Find and Ink
are six independent overlays with no shared model, so they can and do overlap. The dock
takes the four that are genuinely side panels. Outline stays a floating pane and Ink
stays a full-surface overlay — neither is a docked panel and forcing them in would be
worse than leaving them.

`ai-review` is declared here but has no content until the sibling plan's Task 7. A tab
with no child renders no button — the dock must not show an empty tab.

Requirements:
- The dock is a landmark with an accessible name; the tab strip is a `tablist` with
  `role="tab"` / `aria-selected`, and the panel is `role="tabpanel"`.
- Escape closes it and returns focus to the control that opened it.
- The note column reflows rather than being overlapped — no content hidden behind it.
- Below 900px it becomes a full-width sheet. The spec puts a proper mobile pass out of
  scope, but the dock must not be unusable on a phone in the meantime.

**Known defect to fix in this task**, introduced by Task 1 and flagged rather than
hidden: `.folio-outline` carries a pre-existing `@media (min-width: 1200px)`, so below
1200px the new Outline toggle reads `aria-pressed="true"` with nothing on screen. A
control that claims a state it isn't in is worse than no control. Either hide the
Outline toggle below that breakpoint or give the pane a narrow-width presentation —
whichever the dock's layout makes natural. Do not simply force the 220px rail in at
narrow widths; it squeezes the note column, which is why Task 1 left it alone.

- [ ] **Step 1: Write the failing Playwright spec** at `e2e/note-dock.spec.ts`:
  opening Comments then History leaves only History rendered; the Comments badge shows
  the unresolved count; Escape closes the dock and focus returns to the toggle;
  the AI review tab is absent while it has no content.
- [ ] **Step 2: Run it and confirm it fails** — `npm run e2e -- note-dock`.
- [ ] **Step 3: Build `NoteDock.tsx` and its stylesheet.**
- [ ] **Step 4: Move History, Comments and Assistant into it**, stripping their own
  positioning as you go.
- [ ] **Step 5: Verify** — `npm run e2e`, `npm run build -w web`, `npm run lint -w web`.
- [ ] **Step 6: Commit** — `feat(editor): unify the note side panels into one dock`

---

### Task 3: Shrink `NotePage.tsx`

**Files:**
- Modify: `web/src/features/editor/NotePage.tsx`
- Create: `web/src/features/editor/useAiActions.ts`

**Interfaces:**
- Produces:
```ts
export interface AiActions {
  busy: string | null;
  improve: () => Promise<void>;
  clean: () => Promise<void>;
  gaps: () => Promise<void>;
  flashcards: (count: number) => Promise<void>;
  summarize: () => Promise<void>;
  suggestTitle: () => Promise<void>;
}

export function useAiActions(noteId: string, hooks: {
  onTitle: (t: string) => void;
  onEdits: (edits: AiEdit[]) => void;
  onFlashcards: (n: number) => void;
}): AiActions;
```

After Tasks 1 and 2, `NotePage.tsx` should be materially smaller. The six `handleX` AI
functions are the last large block that isn't page state — they share the same
busy/try/catch/finally shape and belong in one hook. `aiError` moves with them.

Do this **after** the sibling plan's Task 9, or the two will collide in the same
functions.

- [ ] **Step 1: Extract the hook**, keeping behaviour identical.
- [ ] **Step 2: Verify nothing moved** — `npm run e2e`, `npm run build -w web`,
  `npm run lint -w web`. This task adds no behaviour, so a green suite is the whole bar.
- [ ] **Step 3: Record the line count** in the commit message, before and after.
- [ ] **Step 4: Commit** — `refactor(editor): extract AI actions out of NotePage`

---

## Sequencing

Task 1 is in flight. Task 2 depends on it only for the toggle state it introduces, so
it should start once `feat/note-action-bar` lands. Task 3 goes last — after the AI
review plan's Task 9 — because both rewrite the same handlers.
