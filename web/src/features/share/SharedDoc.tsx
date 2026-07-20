// The shared view of a DOCUMENT note, for whoever arrived through a share link.
//
// It reuses the app's real extension set (createFolioExtensions) so a guest sees
// the note rendered exactly as its owner does — same callouts, tables, maths,
// code highlighting. What it deliberately does NOT reuse is FolioEditor itself:
// that component wires in the slash menu, image upload and drag handle, all of
// which call owner-only endpoints. A guest clicking them would get a 401 and no
// explanation. Passing `editable: false` to the extension builder is exactly how
// HistoryPanel renders a note without those affordances; the editor instance is
// then made writable or not by `canEdit`, so a guest still gets bold/italic,
// lists, headings and markdown input rules through StarterKit's own keymap.
//
// Merge policy is honest rather than clever: this is whole-document PATCH over a
// poll, so two people typing in the same paragraph WILL overwrite each other.
// Remote content is only applied when this client has nothing unsaved, and the
// header says plainly how the sync works.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import { createFolioExtensions } from '../editor/buildExtensions';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../lib/format';
import type { SharedNote } from '../../lib/types';
import '../editor/editor.css';
import './share.css';

/** Debounce before pushing an edit. Deliberately shorter than the poll interval,
 *  so a pause in typing reaches other people on their very next tick. */
const SAVE_DEBOUNCE_MS = 900;

export interface SharedDocProps {
  token: string;
  initial: SharedNote;
  /** Fired after a successful save so the caller can poll immediately. */
  onSaved?: () => void;
  /** Registers a handler the caller invokes when a remote `doc` event lands. */
  registerDocHandler: (fn: () => void) => void;
  onTitleChange?: (title: string) => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function SharedDoc({ token, initial, onSaved, registerDocHandler, onTitleChange }: SharedDocProps) {
  const canEdit = initial.canEdit;
  const [title, setTitle] = useState(initial.note.title);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [remoteAt, setRemoteAt] = useState<Date | null>(null);

  const editorBox = useRef<Editor | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  // Set the moment anything changes locally, cleared when the save lands. It is
  // what stops a poll from pulling the server's older copy over live typing.
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);

  // onUpdate is captured by the editor instance; reaching the (later-declared)
  // debounce through a ref keeps that closure valid without rebuilding the editor.
  const scheduleRef = useRef<() => void>(() => {});

  const extensions = useMemo(
    // `editable: false` here selects the extension SET (no slash command); the
    // editor's own `editable` flag below decides whether typing is allowed.
    // getNotebookId returns '' because a guest has no notebook context — the only
    // consumer is the wikilink resolver, which then simply finds nothing.
    () =>
      createFolioExtensions({
        editable: false,
        editorBox,
        getNotebookId: () => '',
        // The default placeholder advertises the slash menu, which guests do not
        // get. Promising a command palette that never opens is worse than silence.
        paragraphPlaceholder: canEdit ? 'Start typing…' : '',
      }),
    [canEdit],
  );

  const editor = useEditor({
    extensions,
    content: initial.note.contentJson as JSONContent,
    editable: canEdit,
    editorProps: {
      attributes: {
        class: 'folio-prosemirror',
        spellcheck: 'true',
        'data-testid': 'shared-note-editor',
      },
    },
    onUpdate: ({ transaction }) => {
      if (!transaction.docChanged) return;
      dirtyRef.current = true;
      scheduleRef.current();
    },
  });

  useEffect(() => {
    if (editor) editorBox.current = editor;
    return () => {
      editorBox.current = null;
    };
  }, [editor]);

  const save = useCallback(async () => {
    const ed = editorBox.current;
    if (!ed || ed.isDestroyed || !canEdit) return;
    if (savingRef.current) return;
    if (!dirtyRef.current) return;

    savingRef.current = true;
    // Snapshot BEFORE the await: the user keeps typing during the request, and
    // clearing the flag afterwards would swallow everything typed in between.
    const payload = { title: titleRef.current, contentJson: ed.getJSON() };
    dirtyRef.current = false;
    setSaveState('saving');
    try {
      await api.updateSharedNote(token, payload);
      setSaveState('saved');
      onSaved?.();
    } catch (e) {
      // Restore the dirty flag so the next tick (or the next keystroke) retries;
      // silently dropping an edit on a shared board is the worst failure here.
      dirtyRef.current = true;
      setSaveState('error');
      toast(errorMessage(e, 'Could not save your changes'), 'error');
    } finally {
      savingRef.current = false;
    }
  }, [token, canEdit, onSaved]);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
  }, [save]);
  scheduleRef.current = schedule;

  // Flush on unmount / tab close so a pending edit is not stranded in the
  // debounce window.
  useEffect(() => {
    const flush = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void save();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [save]);

  /**
   * Pull the server's copy after someone else's doc event.
   *
   * The equality check IS the echo suppression: our own write comes back through
   * the feed as an event we cannot attribute (the API never reveals our actor
   * id), so instead we compare content. If the server's document is the one we
   * already have, this is our echo and nothing moves — which is what keeps the
   * caret from jumping every time we save.
   */
  const pullRemote = useCallback(async () => {
    const ed = editorBox.current;
    if (!ed || ed.isDestroyed) return;
    // Never overwrite unsaved local work. The edit is still coming, and letting
    // it land afterwards is last-write-wins — the same as the server's model.
    if (dirtyRef.current || savingRef.current) return;

    try {
      const fresh = await api.sharedNote(token);
      if (fresh.note.title !== titleRef.current) {
        titleRef.current = fresh.note.title;
        setTitle(fresh.note.title);
        onTitleChange?.(fresh.note.title);
      }
      const current = JSON.stringify(ed.getJSON());
      const incoming = JSON.stringify(fresh.note.contentJson);
      if (current === incoming) return; // our own echo

      // setContent resets the selection to the document start, so the caret is
      // put back by offset afterwards. It is an approximation — an edit above the
      // caret shifts it — but it beats being thrown to the top of the note, and
      // this branch only runs when the reader had nothing unsaved anyway.
      const from = ed.state.selection.from;
      ed.commands.setContent(fresh.note.contentJson as JSONContent, { emitUpdate: false });
      const max = ed.state.doc.content.size;
      ed.commands.setTextSelection(Math.min(from, max));
      setRemoteAt(new Date());
      // The "someone else changed this" flag is a transient acknowledgement, not
      // a persistent state — leaving it up forever would make a board look
      // permanently contested.
      window.setTimeout(() => setRemoteAt(null), 4000);
    } catch {
      // The next event retries; a transient failure must not break the session.
    }
  }, [token, onTitleChange]);

  // Hand the puller up to the page, which owns the poll loop.
  useEffect(() => {
    registerDocHandler(() => void pullRemote());
  }, [registerDocHandler, pullRemote]);

  function handleTitle(next: string) {
    setTitle(next);
    titleRef.current = next;
    onTitleChange?.(next);
    dirtyRef.current = true;
    schedule();
  }

  if (!editor) return null;

  return (
    <div className="sh-doc">
      <div className="sh-doc__shell">
        {canEdit ? (
          <input
            className="sh-doc__title"
            value={title}
            placeholder="Untitled"
            aria-label="Note title"
            onChange={(e) => handleTitle(e.target.value)}
          />
        ) : (
          <h1 className="sh-doc__title sh-doc__title--static">{title || 'Untitled'}</h1>
        )}

        <div className="sh-doc__status" role="status">
          {canEdit && saveState === 'saving' && <span className="sh-chip">Saving…</span>}
          {canEdit && saveState === 'saved' && <span className="sh-chip sh-chip--ok">Saved</span>}
          {canEdit && saveState === 'error' && (
            <span className="sh-chip sh-chip--error">
              Save failed
              <button type="button" onClick={() => void save()}>
                Retry
              </button>
            </span>
          )}
          {remoteAt && <span className="sh-chip">Updated by someone else</span>}
        </div>

        <div className={`folio-editor sh-doc__editor${canEdit ? '' : ' is-readonly'}`}>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
