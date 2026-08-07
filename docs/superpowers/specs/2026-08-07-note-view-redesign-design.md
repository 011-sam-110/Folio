# Note view redesign — design

**Date:** 2026-08-07
**Status:** approved, in build
**Visual review:** https://claude.ai/code/artifact/2cbc0629-a58c-4379-a2e2-b7a5e59aa9fb

Two changes to `/note/:noteId`, sharing one piece of new infrastructure.

1. The in-note chrome is cluttered and under-labelled.
2. AI changes arrive as one all-or-nothing blob with no stated reasoning.

They are specified together because the AI review needs a right-hand rail and the
clutter fix needs the six competing overlays unified into one drawer. That is the
same component, built once.

---

## 1. The problem, measured

`folio-action-bar` (`web/src/features/editor/NotePage.tsx`, ~lines 606–769) renders
**twelve sibling controls** in one flat flex row with no grouping and three labelling
conventions:

| Convention | Controls |
| --- | --- |
| Text button | Insert ▾, Assistant, Import into note ▾, History, Export .md |
| Icon only, no visible label | Pin, Comments, Ink, Info |
| Other | AI ▾, Share, autosave chip |

Problems:

- **Four controls have no visible label.** They carry `title` and `aria-label`, so
  assistive tech and a patient hover resolve them, but nothing on screen does.
- **Altitude is flat.** `Export .md` (used almost never) has the same visual weight
  as `Insert` (used constantly).
- **Two unrelated-looking AI doors.** `AI ▾` runs whole-note transforms; `Assistant`
  opens a Q&A panel. Nothing indicates they are related, or which one you want.
- **Six independent overlays** with no shared docking model: History, Comments,
  Assistant, Outline, Find/Replace, Ink.
- **`NotePage.tsx` is 925 lines** with an 881-line stylesheet. One file owns the
  entire surface.

On the AI side, `AiPreviewModal` takes `afterMarkdown: string` — a single blob, one
`Apply`, one `Discard`. There is no notion of a *change* as an object, so there is
nothing to approve individually, and no channel for a rationale.

**Bug found while reading:** `NotePage.tsx:870` passes
`before={note.contentText.slice(0, 600)}`. The Before pane is truncated at 600
characters, so for any note longer than a paragraph today's comparison is already
incomplete. Fixed implicitly by this work; noted here so it isn't rediscovered.

---

## 2. Chrome

### 2.1 Action bar — three zones

Extracted from `NotePage.tsx` into `NoteActionBar.tsx`. `NotePage` remains the state
owner; the bar receives state and callbacks as props.

- **Write (left):** `＋ Insert ▾` (primary), `✦ AI ▾`
- **Panels (middle):** a segmented control — `Outline` · `Comments` (badge) · `Ink` ·
  `Find` · `Assistant`. Each is a stateful toggle carrying `aria-pressed`.
- **Note actions (right, after a spacer):** `Share`, `⋯ More ▾`, autosave chip last.

`⋯ More ▾` holds History, Import into note (Photo / Slides / Transcript), Export .md,
Pin/Unpin, Note info, Summarise, Suggest a title — grouped with hairline dividers,
not nine flat items.

**Every control gets a visible text label.** Existing `title` / `aria-label`
attributes are kept, not replaced.

New state required in `NotePage`: `outlineOpen` (gating `<OutlinePane>`, which
currently renders unconditionally) and a Find toggle routing to the existing
`setFindMode`. The Ctrl/Cmd+F and Ctrl/Cmd+H shortcuts keep working — the buttons are
an additional route, not a replacement.

### 2.2 The AI menu — four actions

| Item | Behaviour |
| --- | --- |
| Improve writing | existing `handleImprove` → **review flow** |
| Clean up formatting | existing `handleClean` → **review flow** |
| Find missing content from uploads | **new**, needs `ai/gaps` → **review flow** |
| Generate flashcards | existing `handleFlashcards`, keeps the 5/8/12 count step |

Below a divider: `Choose what to check…` opens the check picker.

The first three propose changes and write nothing directly. Flashcards is the
exception — it builds cards in the deck rather than editing the note, so it keeps its
existing banner and needs no review.

The whole menu stays gated on `aiOn`, as do the AI items inside `⋯ More`.

**Relocations** (features are moved, never deleted): Assistant → Panels segment;
Summarise and Suggest a title → `⋯ More`.

### 2.3 NoteDock

One right-hand drawer with a tab strip, one panel open at a time, absorbing History,
Comments, Assistant and the new AI review rail. This is the shared infrastructure
referred to above.

---

## 3. AI review

### 3.1 Contract

A client-side text diff can say *what* changed but never *why*. The rationale must
come from the model, attached per edit.

```ts
interface AiEdit {
  id: string;
  blockId: string;                           // TipTap UniqueID of the target block
  op: 'replace' | 'insert' | 'delete';
  before: string;                            // '' for insert
  after: string;                             // '' for delete
  reason: string;                            // model-authored; REQUIRED, non-empty
  checkId: string;                           // e.g. 'accuracy.contradicts-note'
  source?: { attachmentId: string; label: string };  // uploads only
}
```

**Anchoring is by `blockId`** — the stable per-block identifier the `UniqueID`
extension already mints and persists (`buildExtensions.ts:102`,
`UniqueID.configure({ types: UNIQUE_ID_TYPES })`).

This was originally specified as a block *index*. `blockId` is strictly better and
costs nothing, because the ids already exist in every saved document:

| Anchor | Breaks when |
| --- | --- |
| Search for `before` text | the phrase repeats anywhere in the note |
| Character offset | the user types anything at all |
| Block index | the user adds or deletes a block above the edit |
| **`blockId`** | only when that specific block is deleted — detectable, and handled |

The note is serialised for the model as blocks tagged with their id; the model echoes
the id back. `BlockMenu.tsx:130`'s `stripIds` helper is the precedent that these ids
are treated as real identity in this codebase, not incidental attributes.

An edit with an empty `reason` is rejected server-side. A rail card with no reason
renders blank and the entire premise collapses.

### 3.2 Rendering

`createAiReviewPlugin()`, registered in `handleEditorReady` alongside the existing
`createFindReplacePlugin()` and `createHashtagPlugin()`, with the same StrictMode
double-registration guard.

Decorations only — insertions underlined, deletions struck through in place. **The
document is not mutated until an edit is approved**, so autosave never observes a
half-reviewed state.

A snapshot is taken before the first approval (`api.snapshot`, as `applyImprove`
already does), making History the undo path.

### 3.3 The rail

Cards grouped by **severity**, not document order. Severity is a property of the
check family, not chosen per suggestion — which is what keeps "this contradicts your
Dijkstra note" from being buried under six capitalisation fixes.

Each card: category chip, block reference, the reason, Approve / Deny. Upload-sourced
cards additionally cite their source (`os-lecture-7.pdf · slide 14 of 31`).

Footer: Approve all, Discard.

### 3.4 Check catalogue

56 checks in 8 families. Families are also the **unit of execution**: one request per
enabled family, run in parallel. Six to eight related checks per prompt is inside what
a model reads carefully; 56 in one prompt is not.

| Family | n | Severity |
| --- | --- | --- |
| Accuracy | 8 | critical |
| Missing content | 9 | critical |
| Explanation | 7 | normal |
| Clarity | 7 | normal |
| Structure | 8 | normal |
| Visual hierarchy | 6 | normal |
| Grammar | 6 | minor |
| Notebook hygiene | 5 | normal |

**Accuracy** — factual error; contradicts another of your notes; contradicts itself;
wrong term for the concept; formula or equation error; units missing or inconsistent;
misattributed source; superseded or outdated claim.

**Missing content** — term used but never defined; no worked example; missing the
motivation; edge case not covered; dangling reference; count mismatch; unfinished
thought; prerequisite assumed; no complexity or cost given.

**Explanation** — circular definition; jargon used before introduction; skipped step;
restates rather than explains; analogy that breaks down; abstract with no instance;
key point buried at the end.

**Clarity** — ambiguous "it"/"this"; sentence too long to parse; stacked qualifiers;
vague quantifier; passive voice hiding the actor; double negative; two names for one
thing.

**Structure** — heading level skipped; wall of text; section out of order; duplicated
section; heading with nothing under it; should be a list; should be a table; should be
a callout.

**Visual hierarchy** — nothing emphasised in a long passage; over-highlighted;
inconsistent emphasis style; code not in a code block; maths not in a maths block;
better as a chemistry/3D/sketch block.

**Grammar** — spelling; agreement and tense; punctuation; inconsistent capitalisation;
typo in a technical term; mixed British and American spelling.

**Notebook hygiene** — should link to an existing note; near-duplicate of another
note; missing a tag its siblings have; flashcard-worthy passage; title doesn't match
content.

Notebook hygiene is the family a general-purpose writing assistant structurally cannot
offer: those checks need the rest of the notebook, not just the open note.

Catalogue and presets live in one shared `checks.ts` consumed by both the picker and
the server prompts, so the two cannot drift.

### 3.5 Presets

| Preset | Families | Requests |
| --- | --- | --- |
| Lecture notes | Accuracy, Missing content, Structure, Notebook hygiene | 4 |
| Essay draft | Explanation, Clarity, Structure, Grammar | 4 |
| Exam revision | Accuracy, Missing content, Explanation | 3 |
| Proofread only | Grammar | 1 |
| Everything | all eight | 8 |

A preset is a starting point, not a mode: selection is adjustable afterwards and
persists **per notebook**.

### 3.6 Find missing content from uploads

Compares the note against its own `note.attachments` (photo / slides / transcript
imports) rather than asking a model to guess what is absent. Every suggestion is an
`insert` — it never rewrites the student's wording — which is what makes *Approve all*
safe here in a way it is not for *Improve writing*.

Each suggestion cites its source down to slide number or transcript timestamp.

Requires a new `ai/gaps` route. Disabled in the UI, with an honest reason, until that
exists. **Not stubbed and not faked.**

---

## 4. Failure modes that must be designed for

1. **The user edits while reviewing.** Largely solved by `blockId` — an edit still
   finds its block after unrelated blocks are added, removed or reordered. Two cases
   remain: the target block was **deleted** (drop the edit), or its text was **changed**
   so `before` no longer matches (drop the edit). Both must report a count to the user —
   "2 suggestions no longer apply". Silent skipping is worse than the original problem.
2. **Approving one edit moves the others.** Every pending position must be mapped
   through `tr.mapping` after each apply. This is the most likely route to a corrupted
   note.
3. **Edits targeting notation blocks.** Chemistry, 3D and sketch nodes cannot render a
   strikethrough. Decorate the whole node and put before/after in the rail card.
4. **Empty `reason`.** Rejected server-side.
5. **Cost.** Running all eight families is ~8× today's single call against the
   shared-pool quota added in `fc69bec`. The quota check must price a run by enabled
   family count, and the picker must state the cost before the run starts.
6. **Volume.** 56 checks on a long note can yield 40 suggestions — recreating the
   clutter problem in the rail. Severity grouping, collapsed families, per-family bulk
   approve, and a per-family cap with an honest "12 more in Grammar" rather than
   silent truncation.

---

## 5. Files

| File | State | Change |
| --- | --- | --- |
| `NotePage.tsx` | 925 lines | Extract bar and AI handlers out |
| `NoteActionBar.tsx` | new | Three-zone bar |
| `NoteDock.tsx` | new | Tabbed right drawer |
| `AiReviewPlugin.ts` | new | Decorations, approve/deny, remapping |
| `AiReviewRail.tsx` | new | Severity-grouped reason cards |
| `checks.ts` | new | 56-check catalogue + presets, shared with server |
| `CheckPicker.tsx` | new | Families, checks, presets; saved per notebook |
| `AiPreviewModal.tsx` | 70 lines | Kept — still correct for Summarise, which inserts |
| server AI routes | — | Return `AiEdit[]`; one route per family |
| `ai/gaps` | new | Note ↔ attachment comparison |

---

## 6. Out of scope

- Canvas notes (`note.kind === 'canvas'`) — different surface entirely.
- Mobile layout for the rail. Needs its own pass; the dock is desktop-first.
- Inline title suggestion on the title field. Wanted, but scope creep on a bar
  refactor; `Suggest a title` sits in `⋯ More` for now.
- `web/index.html` — carries a sha256-pinned inline script whose hash is duplicated in
  `vercel.json` and `server/src/lib/csp.ts`. Editing it, even a comment, silently
  breaks CSP in production. **Do not touch.**
