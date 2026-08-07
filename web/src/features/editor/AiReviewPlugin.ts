// The AI review layer: every suggestion the model made, painted over the note as
// decorations, with nothing written into the document until the reader approves it.
//
// Ownership/registration note: this is the third plain ProseMirror plugin on this page and
// follows the two that came before it exactly - FindReplace.ts and HashtagExtension.ts.
// NotePage.tsx calls `editor.registerPlugin(createAiReviewPlugin())` once the editor is
// ready (a documented TipTap API for attaching a plain plugin to an already-constructed
// editor) rather than adding a slot to buildExtensions.ts's shared array, which is also
// used by the read-only HistoryPanel preview and the shared-link editor, neither of which
// has anything to review.
//
// WHY DECORATIONS AND NOT A DOCUMENT REWRITE. The old flow replaced the whole note with the
// model's version and offered one Apply button. Reviewing suggestion by suggestion means the
// document has to hold the student's text and the model's proposal at the same time, and
// only one of those may ever reach the server. Decorations are view-only: they never appear
// in `editor.getJSON()` or `editor.getText()`, so the autosave snapshot NotePage captures on
// every keystroke cannot observe a half-reviewed note. A student who opens a review, walks
// off to a lecture and comes back to a reloaded tab gets their own note, not a note full of
// suggestions they never accepted.
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { AiEdit } from '../../lib/types';

export type AiVerdict = 'approved' | 'denied';

/**
 * Where one suggestion currently sits in the document.
 *
 * Recomputed from scratch on every document change and never persisted - see the comment on
 * `apply`. The rail reads `kind` to decide what it may offer: a `node` anchor is a notation
 * block, which has no inline text to rewrite, so its card shows the before/after and does
 * not offer Approve.
 */
export type Anchor =
  /** replace / delete: the exact range holding the edit's `before` text. */
  | { kind: 'text'; from: number; to: number }
  /** insert: the point the new text would go in. */
  | { kind: 'point'; at: number }
  /** A chem / model3d / sketch block: an atom with no inline text of its own. */
  | { kind: 'node'; from: number; to: number };

export interface AiReviewState {
  /** Every edit in this run that has not been approved or denied. Includes the currently
   *  stale ones, so that an edit whose block the user is mid-way through retyping comes
   *  back on its own rather than being lost. */
  pending: AiEdit[];
  settled: Record<string, AiVerdict>;
  /** Ids whose block vanished, or whose `before` no longer appears in it. */
  stale: string[];
  /** Resolved position per pending, non-stale edit, against the CURRENT document only. */
  anchors: Record<string, Anchor>;
  /** Cached rather than recomputed in `props.decorations`, which the view calls far more
   *  often than the document changes - the same trade FindReplace.ts makes. */
  decorations: DecorationSet;
}

export const AiReviewPluginKey = new PluginKey<AiReviewState>('folioAiReview');

type Meta =
  | { type: 'set'; edits: AiEdit[] }
  | { type: 'settle'; id: string; verdict: AiVerdict }
  | { type: 'clear' };

function emptyState(): AiReviewState {
  return { pending: [], settled: {}, stale: [], anchors: {}, decorations: DecorationSet.empty };
}

// ---------------------------------------------------------------------------
// Finding a block, and finding text inside it
// ---------------------------------------------------------------------------

interface BlockHit {
  node: PMNode;
  pos: number;
}

/**
 * Index every id-bearing node in the document by its `UniqueID`.
 *
 * Built once per resolution pass rather than once per edit: a long note can come back with
 * forty suggestions, and forty separate walks of the same document is forty times the work
 * for the same answer.
 *
 * `buildExtensions.ts` configures `UniqueID` for a fixed list of types (heading, paragraph,
 * the three list types, blockquote, codeBlock, table, image, callout, details, columnList
 * and the three notation blocks). A `listItem`, a `tableRow` or a bare text node therefore
 * never carries one, so an edit naming a type outside that list finds nothing here and is
 * reported stale - which is the honest answer, and the same one a genuinely deleted block
 * gets. Guessing at an anchor for a node type the editor does not label would be worse than
 * saying so.
 */
function indexBlocks(doc: PMNode): Map<string, BlockHit> {
  const byId = new Map<string, BlockHit>();
  doc.descendants((node, pos) => {
    const id: unknown = node.attrs?.id;
    // First one wins. `descendants` is outside-in, so a list keeps the id the model was
    // shown for it even though the paragraphs inside it carry ids of their own.
    if (typeof id === 'string' && id && !byId.has(id)) byId.set(id, { node, pos });
    return true;
  });
  return byId;
}

interface TextRun {
  /** Absolute document position of this run's first character. */
  from: number;
  text: string;
}

/** A block's inline text, flattened, with a document position for every character. */
interface FlatBlock {
  text: string;
  /** `map[i]` is the document position of `text[i]`; -1 for a synthesised separator. */
  map: number[];
  runs: TextRun[];
}

/**
 * Flatten a block's inline text.
 *
 * Runs that are not physically adjacent are joined with a newline rather than concatenated,
 * because a gap between them means a node boundary - the second paragraph of a list item,
 * the next row of a table. The server's `plainTextFromDoc` (which produced the text the
 * model actually read, and therefore the text an edit's `before` was quoted from) separates
 * those same boundaries with a newline, so joining them any other way would make a quote
 * spanning two paragraphs impossible to match.
 */
function flattenBlock(node: PMNode, nodePos: number): FlatBlock {
  const runs: TextRun[] = [];
  node.descendants((child, offset) => {
    // `offset` is relative to the start of `node`'s content, which begins at nodePos + 1.
    if (child.isText && child.text) runs.push({ from: nodePos + 1 + offset, text: child.text });
    return true;
  });

  let text = '';
  const map: number[] = [];
  let prevEnd = -1;
  for (const run of runs) {
    if (prevEnd >= 0 && run.from !== prevEnd) {
      text += '\n';
      map.push(-1);
    }
    for (let i = 0; i < run.text.length; i++) {
      text += run.text[i];
      map.push(run.from + i);
    }
    prevEnd = run.from + run.text.length;
  }
  return { text, map, runs };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `before` text as a pattern, with every run of whitespace allowed to match any other.
 *
 * Exact string matching is too brittle in practice: a model re-emits a quote with the line
 * break collapsed to a space, or a double space normalised, and the suggestion would be
 * reported stale for a difference no reader would notice. Only whitespace is loosened -
 * every non-space character still has to be there, in order, so this can widen which
 * whitespace a match covers but can never make it match different words.
 */
function needlePattern(needle: string): string {
  return needle.trim().split(/\s+/).map(escapeRegex).join('\\s+');
}

function matchesNeedle(text: string, needle: string): boolean {
  return new RegExp(`^${needlePattern(needle)}$`).test(text);
}

interface Range {
  from: number;
  to: number;
}

function overlaps(range: Range, claimed: Range[]): boolean {
  return claimed.some((c) => range.from < c.to && c.from < range.to);
}

/**
 * Where in `flat` the edit's `before` currently sits.
 *
 * `preferred` is this edit's range from the previous pass, carried forward through
 * `tr.mapping`. It is tried first and accepted only if the text it now covers still is the
 * quote - see `apply` for why a hint is worth having at all.
 *
 * `claimed` holds the ranges other suggestions in this pass already took, so two edits
 * quoting the same phrase twice in one block do not both land on the first occurrence and
 * then both rewrite it.
 */
function locate(flat: FlatBlock, before: string, preferred: Anchor | undefined, claimed: Range[]): Range | null {
  const needle = before.trim();
  if (!needle) return null;

  if (preferred?.kind === 'text' && !overlaps(preferred, claimed)) {
    const first = flat.map.find((p) => p >= 0) ?? -1;
    const last = flat.map.reduce((acc, p) => (p >= 0 ? p : acc), -1);
    if (first >= 0 && preferred.from >= first && preferred.to <= last + 1) {
      const covered = textAt(flat, preferred);
      if (covered !== null && matchesNeedle(covered, needle)) return { from: preferred.from, to: preferred.to };
    }
  }

  const re = new RegExp(needlePattern(needle), 'g');
  for (let m = re.exec(flat.text); m !== null; m = re.exec(flat.text)) {
    const from = flat.map[m.index];
    const lastChar = flat.map[m.index + m[0].length - 1];
    // A match whose first or last character is a synthesised separator has no real position
    // to anchor to. Cannot happen with a trimmed needle, but the map is the only thing
    // standing between a regex index and a document position, so it is checked.
    if (from < 0 || lastChar < 0) continue;
    const range = { from, to: lastChar + 1 };
    if (!overlaps(range, claimed)) return range;
  }
  return null;
}

/** The flattened text covered by a document range, or null if it falls outside the block. */
function textAt(flat: FlatBlock, range: Range): string | null {
  let out = '';
  let seen = false;
  // A separator only belongs in the answer if the range continues past it - otherwise a
  // range ending on the last word of a paragraph would come back with a trailing newline
  // the quote never had, and the equality check against `before` would fail on nothing.
  let pendingSeparator = false;
  for (let i = 0; i < flat.map.length; i++) {
    const pos = flat.map[i];
    if (pos < 0) {
      if (seen) pendingSeparator = true;
      continue;
    }
    if (pos >= range.from && pos < range.to) {
      if (pendingSeparator) out += '\n';
      pendingSeparator = false;
      out += flat.text[i];
      seen = true;
    } else {
      pendingSeparator = false;
    }
  }
  return seen ? out : null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Resolution {
  anchors: Record<string, Anchor>;
  stale: string[];
}

function resolveOne(
  edit: AiEdit,
  blocks: Map<string, BlockHit>,
  preferred: Anchor | undefined,
  claimed: Range[],
): Anchor | null {
  const block = blocks.get(edit.blockId);
  if (!block) return null;

  // Notation blocks (chem, model3d, sketch) are atoms - all their state lives in attrs and
  // there is no inline text, so there is nothing to strike a line through and nothing an
  // approval could replace. Decorate the whole node and let the rail card carry the
  // before/after in words; its Approve button is not offered for this anchor kind.
  if (block.node.isAtom || block.node.isLeaf) {
    return { kind: 'node', from: block.pos, to: block.pos + block.node.nodeSize };
  }

  const flat = flattenBlock(block.node, block.pos);

  if (edit.op === 'insert' && !edit.before.trim()) {
    // Nothing quoted to anchor against, so the addition goes at the end of the block's own
    // text. The END of the last run, rather than the end of the node, because a list's last
    // position is between its items and not inside a textblock - inserting there throws.
    const last = flat.runs[flat.runs.length - 1];
    if (!last) return null;
    return { kind: 'point', at: last.from + last.text.length };
  }

  const range = locate(flat, edit.before, preferred, claimed);
  if (!range) return null;
  return edit.op === 'insert' ? { kind: 'point', at: range.to } : { kind: 'text', from: range.from, to: range.to };
}

function resolveAll(edits: AiEdit[], doc: PMNode, preferred: Record<string, Anchor>): Resolution {
  const blocks = indexBlocks(doc);
  const anchors: Record<string, Anchor> = {};
  const stale: string[] = [];
  const claimed: Range[] = [];

  for (const edit of edits) {
    const anchor = resolveOne(edit, blocks, preferred[edit.id], claimed);
    if (!anchor) {
      stale.push(edit.id);
      continue;
    }
    anchors[edit.id] = anchor;
    if (anchor.kind === 'text') claimed.push(anchor);
  }
  return { anchors, stale };
}

/**
 * Carry one anchor through a transaction's position mapping.
 *
 * Returns null when the transaction replaced the very text the anchor covered. A mapped
 * position for a deleted range is a guess about text that no longer exists, and following it
 * would point the suggestion at whatever happens to sit there now; dropping the hint instead
 * sends the edit back through a fresh search of its block, which either finds the phrase
 * somewhere else or reports the suggestion stale. Both are answers; a guess is not.
 */
function mapAnchor(anchor: Anchor, mapping: Mapping): Anchor | null {
  if (anchor.kind === 'point') {
    const res = mapping.mapResult(anchor.at, 1);
    return res.deleted ? null : { kind: 'point', at: res.pos };
  }
  const start = mapping.mapResult(anchor.from, 1);
  const end = mapping.mapResult(anchor.to, -1);
  if (start.deleted || end.deleted || end.pos <= start.pos) return null;
  return { kind: anchor.kind, from: start.pos, to: end.pos };
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

function insertionWidget(edit: AiEdit): () => HTMLElement {
  return () => {
    const span = document.createElement('span');
    span.className = 'folio-ai-ins';
    span.setAttribute('data-edit-id', edit.id);
    // Belt and braces on top of ProseMirror's own widget handling: a widget the browser
    // considers editable is a place the caret can land and the student can type, and
    // anything typed there would be invisible to `getJSON()` and lost on the next render.
    span.contentEditable = 'false';
    span.textContent = edit.after;
    return span;
  };
}

function buildDecorations(doc: PMNode, edits: AiEdit[], anchors: Record<string, Anchor>, stale: string[]): DecorationSet {
  const skip = new Set(stale);
  const decorations: Decoration[] = [];

  for (const edit of edits) {
    if (skip.has(edit.id)) continue;
    const anchor = anchors[edit.id];
    if (!anchor) continue;

    if (anchor.kind === 'node') {
      decorations.push(
        Decoration.node(anchor.from, anchor.to, { class: 'folio-ai-block', 'data-edit-id': edit.id }),
      );
      continue;
    }

    // Replace and delete strike the existing words through and LEAVE THEM THERE. Removing
    // them from the view before the reader has agreed would make the note unreadable at
    // exactly the moment they are trying to judge the suggestion against it.
    if (anchor.kind === 'text') {
      decorations.push(
        Decoration.inline(anchor.from, anchor.to, { class: 'folio-ai-del', 'data-edit-id': edit.id }),
      );
    }

    // The proposed text is a widget, not document content: there is nothing in the document
    // to underline until an approval puts it there.
    if (edit.op !== 'delete' && edit.after) {
      const at = anchor.kind === 'text' ? anchor.to : anchor.at;
      decorations.push(
        Decoration.widget(at, insertionWidget(edit), { side: 1, key: `folio-ai-ins-${edit.id}` }),
      );
    }
  }

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/** A fresh plugin per editor instance (NotePage registers one on every note it opens). */
export function createAiReviewPlugin(): Plugin<AiReviewState> {
  return new Plugin<AiReviewState>({
    key: AiReviewPluginKey,
    state: {
      init: () => emptyState(),

      /**
       * Rebuild the review for the document this transaction produced.
       *
       * THIS IS THE FUNCTION THAT DECIDES WHETHER THIS FEATURE CORRUPTS NOTES. Approving a
       * suggestion that turns "keep the left subtree smaller and the right subtree larger"
       * into "order their subtrees" removes 38 characters, and every position after it in
       * the document moves back by 38. A pending suggestion three blocks further down, if it
       * were still holding the position it was resolved at, would now point 38 characters
       * past the words it was about - and approving it would rewrite the middle of a
       * sentence that was never flagged, in a student's own note, with no diff to show for
       * it. There is no error message for that; it just reads wrong later.
       *
       * Two independent defences, in this order:
       *
       * 1. NO POSITION EVER SURVIVES A TRANSACTION. `pending` holds `AiEdit`s, and an
       *    `AiEdit` carries a `blockId` and the quoted `before` text and no positions at
       *    all. Every anchor below is re-derived from that blockId against `tr.doc` - the
       *    document as it is NOW. A position computed against a document that no longer
       *    exists therefore cannot survive long enough to be used, which makes the whole
       *    class of bug structurally impossible rather than merely handled carefully.
       *
       * 2. The previous pass's anchors are mapped forward through `tr.mapping` and offered
       *    to the re-resolution as a HINT. That is not redundant with (1): when a block
       *    quotes the same phrase twice, a text search on its own gives both suggestions the
       *    first occurrence, whereas the mapped range remembers which occurrence each
       *    suggestion has been about since the run started. The hint is accepted only if the
       *    text at the mapped range still IS that edit's `before`; otherwise it is thrown
       *    away and the search runs. A hint that has to prove itself cannot mislead.
       *
       * An edit that resolves to nothing is never dropped. Its id moves into `stale`, the
       * rail reports the count, and the edit stays in `pending` so that a block being
       * retyped can bring its suggestion back. A suggestion that quietly disappears is
       * indistinguishable, to the reader, from one that was never made.
       */
      apply(tr, prev, _oldState, newState): AiReviewState {
        const meta = tr.getMeta(AiReviewPluginKey) as Meta | undefined;

        if (meta?.type === 'clear') return emptyState();

        let pending = prev.pending;
        let settled = prev.settled;

        if (meta?.type === 'set') {
          pending = meta.edits;
          settled = {};
        } else if (meta?.type === 'settle') {
          pending = prev.pending.filter((e) => e.id !== meta.id);
          settled = { ...prev.settled, [meta.id]: meta.verdict };
        }

        // A selection move, a scroll, a plugin of someone else's - nothing that could have
        // moved a single character. Reusing the previous state keeps this off the keystroke
        // path entirely when no review is running.
        if (!meta && !tr.docChanged) return prev;
        if (pending.length === 0) return { pending, settled, stale: [], anchors: {}, decorations: DecorationSet.empty };

        const hints: Record<string, Anchor> = {};
        for (const [id, anchor] of Object.entries(prev.anchors)) {
          const carried = tr.docChanged ? mapAnchor(anchor, tr.mapping) : anchor;
          if (carried) hints[id] = carried;
        }

        const { anchors, stale } = resolveAll(pending, newState.doc, hints);
        return {
          pending,
          settled,
          stale,
          anchors,
          decorations: buildDecorations(newState.doc, pending, anchors, stale),
        };
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? null;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Start a review. Replaces any run already on screen. */
export function setReviewEdits(view: EditorView, edits: AiEdit[]): void {
  view.dispatch(view.state.tr.setMeta(AiReviewPluginKey, { type: 'set', edits } satisfies Meta));
}

/** End the review, decorations and all. */
export function clearReview(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(AiReviewPluginKey, { type: 'clear' } satisfies Meta));
}

export function denyEdit(view: EditorView, editId: string): void {
  view.dispatch(
    view.state.tr.setMeta(AiReviewPluginKey, { type: 'settle', id: editId, verdict: 'denied' } satisfies Meta),
  );
}

/**
 * Write one suggestion into the document.
 *
 * The anchor is re-resolved here against `view.state.doc` instead of being read straight out
 * of `state.anchors`, even though `apply` has already resolved it against that same
 * document. It costs one walk of the note and it closes the only remaining gap: a caller
 * holding a React render's worth of stale state, or two approvals dispatched in the same
 * tick, would otherwise be able to hand this function a position from one document and have
 * it applied to another. The stored anchor is still passed in as the hint, so a repeated
 * phrase keeps the occurrence it has had all along.
 *
 * Returns false rather than throwing when the edit cannot be applied - a notation block, a
 * suggestion that has gone stale, or a quote spanning a node boundary that ProseMirror will
 * not let us replace. The rail turns that into a visible verdict; a thrown exception here
 * would take the editor's whole transaction pipeline with it.
 */
export function approveEdit(view: EditorView, editId: string): boolean {
  const state = AiReviewPluginKey.getState(view.state);
  if (!state) return false;
  const edit = state.pending.find((e) => e.id === editId);
  if (!edit) return false;

  const blocks = indexBlocks(view.state.doc);
  const claimed: Range[] = [];
  for (const [id, other] of Object.entries(state.anchors)) {
    if (id !== editId && other.kind === 'text') claimed.push({ from: other.from, to: other.to });
  }
  const anchor = resolveOne(edit, blocks, state.anchors[editId], claimed);
  if (!anchor || anchor.kind === 'node') return false;

  // A model returns `after` as a line of prose; a text node holding a newline renders as a
  // space anyway and gives ProseMirror a character it cannot round-trip through HTML. The
  // replacement is inline text going into an inline range, so folding the breaks is the
  // honest reading of what was suggested rather than a silent alteration of it.
  const after = edit.after.replace(/\s*\r?\n\s*/g, ' ');

  try {
    const tr = view.state.tr;
    if (anchor.kind === 'text') {
      if (edit.op === 'delete') tr.delete(anchor.from, anchor.to);
      else tr.insertText(after, anchor.from, anchor.to);
    } else {
      tr.insertText(after, anchor.at);
    }
    tr.setMeta(AiReviewPluginKey, { type: 'settle', id: editId, verdict: 'approved' } satisfies Meta);
    view.dispatch(tr);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read helpers for the rail
// ---------------------------------------------------------------------------

export function reviewStateOf(editor: Editor | null): AiReviewState | null {
  if (!editor || editor.isDestroyed) return null;
  return AiReviewPluginKey.getState(editor.state) ?? null;
}

/** Pending edits that currently resolve - i.e. the ones worth rendering a card for. */
export function activeEdits(state: AiReviewState): AiEdit[] {
  const skip = new Set(state.stale);
  return state.pending.filter((e) => !skip.has(e.id));
}

/** Whether Approve can do anything for this edit. False for notation blocks. */
export function isApplicable(state: AiReviewState, editId: string): boolean {
  const anchor = state.anchors[editId];
  return !!anchor && anchor.kind !== 'node';
}

const BLOCK_LABELS: Record<string, string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  bulletList: 'List',
  orderedList: 'List',
  taskList: 'Tasks',
  blockquote: 'Quote',
  codeBlock: 'Code',
  table: 'Table',
  image: 'Image',
  callout: 'Callout',
  details: 'Details',
  columnList: 'Columns',
  chem: 'Chemistry',
  model3d: '3D model',
  sketch: 'Sketch',
};

/**
 * A human reference for the block a card is about, e.g. `Paragraph 4` or `Heading "Trees"`.
 *
 * Counted over TOP-LEVEL nodes, because that is the unit a reader scrolls past. A paragraph
 * nested in a list reports the position of the list, which is where their eye has to go.
 */
export function describeBlock(editor: Editor | null, blockId: string): string {
  if (!editor || editor.isDestroyed) return 'This note';
  const doc = editor.state.doc;
  const hit = indexBlocks(doc).get(blockId);
  if (!hit) return 'Removed block';

  if (hit.node.type.name === 'heading') {
    const text = hit.node.textContent.trim();
    return text ? `Heading “${text.length > 32 ? `${text.slice(0, 32)}…` : text}”` : 'Heading';
  }

  let ordinal = 0;
  doc.forEach((child, offset, index) => {
    if (hit.pos >= offset && hit.pos < offset + child.nodeSize) ordinal = index + 1;
  });
  const label = BLOCK_LABELS[hit.node.type.name] ?? 'Block';
  return ordinal ? `${label} ${ordinal}` : label;
}

/** Scrolls a suggestion's decoration into view without moving the caret. */
export function revealEdit(editor: Editor | null, editId: string): void {
  if (!editor || editor.isDestroyed) return;
  const el = editor.view.dom.querySelector(`[data-edit-id="${CSS.escape(editId)}"]`);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
