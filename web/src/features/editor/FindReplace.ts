// In-note find/replace: a plain ProseMirror plugin (decorations for every match, a
// distinct highlight for the "current" one) plus a small imperative API that
// FindReplaceBar.tsx drives.
//
// Ownership note: buildExtensions.ts/FolioEditor.tsx (where the shared extensions array is
// built) belong to editor-blocks this wave, so this plugin is NOT added to that array.
// Instead NotePage.tsx (ours) calls `editor.registerPlugin(findReplacePlugin)` once the
// editor is ready - a documented TipTap API for attaching a plain ProseMirror plugin to an
// already-constructed editor - and `editor.unregisterPlugin(FindReplacePluginKey)` on
// teardown. That keeps the whole feature inside files we own.
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export const FindReplacePluginKey = new PluginKey<FindReplaceState>('folioFindReplace');

export interface FindReplaceMatch {
  from: number;
  to: number;
}

interface FindReplaceState {
  query: string;
  matches: FindReplaceMatch[];
  currentIndex: number; // -1 when there are no matches
  decorations: DecorationSet;
}

type Meta = { type: 'query'; query: string } | { type: 'index'; index: number } | { type: 'clear' };

/** Case-insensitive, non-overlapping scan of every text node in the doc. Recomputed from
 *  scratch on every query change / doc change - note bodies are small (the AI size guard
 *  caps them around 24k chars elsewhere) so this is cheap relative to a keystroke. */
function computeMatches(doc: PMNode, query: string): FindReplaceMatch[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches: FindReplaceMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let idx = 0;
    for (;;) {
      const found = text.indexOf(q, idx);
      if (found === -1) break;
      matches.push({ from: pos + found, to: pos + found + q.length });
      idx = found + q.length;
    }
  });
  return matches;
}

function buildDecorations(doc: PMNode, matches: FindReplaceMatch[], currentIndex: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === currentIndex ? 'folio-find-match folio-find-match-current' : 'folio-find-match',
    }),
  );
  return DecorationSet.create(doc, decos);
}

/** A fresh plugin per editor instance (NotePage registers one on every note it opens). */
export function createFindReplacePlugin(): Plugin<FindReplaceState> {
  return new Plugin<FindReplaceState>({
    key: FindReplacePluginKey,
    state: {
      init(): FindReplaceState {
        return { query: '', matches: [], currentIndex: -1, decorations: DecorationSet.empty };
      },
      apply(tr, prev, _oldState, newState): FindReplaceState {
        const meta = tr.getMeta(FindReplacePluginKey) as Meta | undefined;

        if (meta?.type === 'clear') {
          return { query: '', matches: [], currentIndex: -1, decorations: DecorationSet.empty };
        }

        let { query, currentIndex } = prev;
        let { matches } = prev;

        if (meta?.type === 'query') {
          query = meta.query;
          matches = computeMatches(newState.doc, query);
          currentIndex = matches.length ? 0 : -1;
        } else if (tr.docChanged) {
          matches = computeMatches(newState.doc, query);
          currentIndex = matches.length ? Math.min(Math.max(currentIndex, 0), matches.length - 1) : -1;
        } else if (meta?.type === 'index') {
          currentIndex = meta.index;
        } else {
          // Unrelated transaction (e.g. a plain selection change) - nothing to recompute.
          return prev;
        }

        return { query, matches, currentIndex, decorations: buildDecorations(newState.doc, matches, currentIndex) };
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? null;
      },
    },
  });
}

function getState(editor: Editor): FindReplaceState | undefined {
  if (editor.isDestroyed) return undefined;
  return FindReplacePluginKey.getState(editor.state);
}

/** Sets the search query and - like a browser's find-as-you-type - jumps straight to the
 *  first match (decoration-only highlight + scrollIntoView, no DOM focus stolen from the
 *  search input). Matches are computed here (not just inside the plugin's `apply`) so this
 *  function knows where the first match landed without a second round trip. */
export function setQuery(editor: Editor, query: string): void {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  const matches = computeMatches(state.doc, query);
  let tr = state.tr.setMeta(FindReplacePluginKey, { type: 'query', query });
  if (matches.length > 0) {
    const m = matches[0];
    tr = tr.setSelection(TextSelection.create(state.doc, m.from, m.to)).scrollIntoView();
  }
  view.dispatch(tr);
}

export function clearFind(editor: Editor): void {
  if (editor.isDestroyed) return;
  const tr = editor.state.tr.setMeta(FindReplacePluginKey, { type: 'clear' });
  editor.view.dispatch(tr);
}

export interface MatchState {
  total: number;
  index: number; // -1 when no matches; otherwise 0-based
}

export function getMatchState(editor: Editor): MatchState {
  const s = getState(editor);
  return { total: s?.matches.length ?? 0, index: s?.currentIndex ?? -1 };
}

/** Moves to and (softly) scrolls the match at `index` into view WITHOUT stealing DOM
 *  focus from the find input - the "current" highlight comes from the decoration, not
 *  native selection rendering, so the search box can stay focused across Enter/Next/Prev. */
function goToIndex(editor: Editor, index: number): void {
  if (editor.isDestroyed) return;
  const s = getState(editor);
  if (!s || s.matches.length === 0) return;
  const clamped = ((index % s.matches.length) + s.matches.length) % s.matches.length;
  const m = s.matches[clamped];
  const { state, view } = editor;
  const tr = state.tr
    .setMeta(FindReplacePluginKey, { type: 'index', index: clamped })
    .setSelection(TextSelection.create(state.doc, m.from, m.to))
    .scrollIntoView();
  view.dispatch(tr);
}

export function findNext(editor: Editor): void {
  const s = getState(editor);
  if (!s || s.matches.length === 0) return;
  goToIndex(editor, s.currentIndex < 0 ? 0 : s.currentIndex + 1);
}

export function findPrev(editor: Editor): void {
  const s = getState(editor);
  if (!s || s.matches.length === 0) return;
  goToIndex(editor, s.currentIndex < 0 ? s.matches.length - 1 : s.currentIndex - 1);
}

/** Replaces the current match only. The plugin recomputes matches automatically (the
 *  transaction is doc-changing), keeping the same numeric index so a follow-up "next"
 *  naturally lands on whichever match now sits at that position. */
export function replaceCurrent(editor: Editor, replacement: string): boolean {
  if (editor.isDestroyed) return false;
  const s = getState(editor);
  if (!s || s.currentIndex < 0) return false;
  const m = s.matches[s.currentIndex];
  if (!m) return false;
  const tr = editor.state.tr.insertText(replacement, m.from, m.to);
  editor.view.dispatch(tr);
  return true;
}

/** Replaces every current match of `query` with `replacement` in one transaction
 *  (back-to-front so earlier positions stay valid while later ones are rewritten).
 *  Returns the number of replacements made. */
export function replaceAll(editor: Editor, query: string, replacement: string): number {
  if (editor.isDestroyed || !query) return 0;
  const matches = computeMatches(editor.state.doc, query);
  if (matches.length === 0) return 0;
  let tr = editor.state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    tr = tr.insertText(replacement, m.from, m.to);
  }
  editor.view.dispatch(tr);
  return matches.length;
}
