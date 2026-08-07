// The editor page (`/note/:noteId`) - the crown jewel. Loads the note, then hands off
// to NoteWorkspace (keyed by note id) which owns the title, TipTap editor, autosave,
// history/AI/import affordances and the backlinks sections.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Editor } from '@tiptap/core';
import { api, ApiError } from '../../lib/api';
import type { AiSuggestResult, Note, NoteLite, Attachment } from '../../lib/types';
import { relativeTime, plural, formatBytes } from '../../lib/format';
import { toast } from '../../components/Toast';
import { setActiveNotebook, clearActiveNotebook } from '../../lib/notebookContext';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import Icon from '../../components/Icon';
import NoteCard from '../../components/NoteCard';
import FolioEditor from './FolioEditor';
import TagEditor from './TagEditor';
import OutlinePane from './OutlinePane';
import HistoryPanel from './HistoryPanel';
import AssistantPanel from './AssistantPanel';
import AiPreviewModal from './AiPreviewModal';
import NoteActionBar from './NoteActionBar';
import InsertMenuPopover from './InsertMenuPopover';
import ImportModal from '../import/ImportModal';
import { useAiAvailable } from '../../lib/aiStatus';
import { useAutosave } from './useAutosave';
import { setActiveFlush } from './autosaveBus';
import { markdownToSafeHtml } from './markdown';
import type { OutlineItem } from './outline';
import CommentsPanel from '../comments/CommentsPanel';
import CanvasBoard from '../canvas/CanvasBoard';
import NoteInkOverlay from '../canvas/NoteInkOverlay';
import FindReplaceBar, { type FindReplaceMode } from './FindReplaceBar';
import { createFindReplacePlugin, FindReplacePluginKey } from './FindReplace';
import { createHashtagPlugin, HashtagPluginKey } from './HashtagExtension';
import AiReviewRail from './AiReviewRail';
import CheckPicker from './CheckPicker';
import { AiReviewPluginKey, createAiReviewPlugin, setReviewEdits } from './AiReviewPlugin';
import { fetchCheckCatalogue, resolveFamilies } from '../../lib/checksApi';
import { extractHashtags, normalizeTags, unionTags, invalidateTagVocabulary } from '../../lib/tags';
import './notePage.css';

export default function NotePage() {
  const { noteId } = useParams<{ noteId: string }>();
  const [state, setState] = useState<{ note: Note; backlinks: NoteLite[] } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  // Monotonic request id guards against the note-load race: rapid A→B→A navigation could
  // otherwise let a stale GET resolve LAST and swap the editor to a different note's content
  // (the root cause of the "caret jumps to start mid-typing" bug). Only the latest request
  // is allowed to commit its result.
  const loadSeq = useRef(0);

  const load = useCallback((id: string) => {
    const seq = ++loadSeq.current;
    setStatus('loading');
    api
      .note(id)
      .then(({ note, backlinks }) => {
        if (loadSeq.current !== seq) return; // superseded by a newer navigation
        setState({ note, backlinks });
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (loadSeq.current !== seq) return;
        if (e instanceof ApiError && e.status === 404) setStatus('notfound');
        else {
          setErrorMsg(e instanceof Error ? e.message : 'Failed to load note');
          setStatus('error');
        }
      });
  }, []);

  useEffect(() => {
    if (noteId) load(noteId);
    return () => {
      // Invalidate any in-flight load when the note id changes / component unmounts.
      loadSeq.current++;
    };
  }, [noteId, load]);

  if (status === 'loading') {
    return (
      <div className="folio-note-page">
        <div className="folio-note-main">
          <div className="folio-note-shell">
            <Skeleton lines={1} />
            <div style={{ height: 40 }} />
            <Skeleton lines={8} />
          </div>
        </div>
      </div>
    );
  }

  if (status === 'notfound') {
    return (
      <div className="folio-note-missing">
        <EmptyState
          icon="🔍"
          title="Note not found"
          hint="It may have been deleted, or the link is broken."
          action={
            <Link className="folio-btn-primary" to="/">
              ← Back to dashboard
            </Link>
          }
        />
      </div>
    );
  }

  if (status === 'error' || !state) {
    return (
      <div className="folio-note-missing">
        <EmptyState
          icon="⚠️"
          title="Couldn't load this note"
          hint={errorMsg}
          action={
            <button type="button" className="folio-btn-primary" onClick={() => noteId && load(noteId)}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  // A canvas is still a note (same id space, same notebook, same trash), but its
  // content lives in canvas_items/canvas_edges rather than content_json - so the
  // whole TipTap workspace below is the wrong surface for it. Branch before
  // mounting NoteWorkspace rather than inside it: the editor, autosave, outline
  // and comments machinery all assume a document and none of it applies here.
  if (state.note.kind === 'canvas') {
    return <CanvasBoard key={state.note.id} note={state.note} />;
  }

  return (
    <NoteWorkspace
      key={state.note.id}
      initialNote={state.note}
      initialBacklinks={state.backlinks}
    />
  );
}

interface NoteWorkspaceProps {
  initialNote: Note;
  initialBacklinks: NoteLite[];
}

/**
 * Split a note's persisted tags into the two authoring routes that produced them.
 * Anything currently written as a #hashtag in the body belongs to the body (its
 * chip is read-only); everything else was added explicitly in the chip editor.
 * Doing this on load is what stops a hashtag from "graduating" into an explicit
 * chip that the user could remove but the next save would resurrect.
 */
function splitTags(tags: readonly string[], contentText: string) {
  const fromBody = extractHashtags(contentText);
  const explicit = normalizeTags(tags).filter((t) => !fromBody.includes(t));
  return { explicit, fromBody };
}

function NoteWorkspace({ initialNote, initialBacklinks }: NoteWorkspaceProps) {
  const navigate = useNavigate();
  const [note, setNote] = useState(initialNote);
  const [backlinks, setBacklinks] = useState(initialBacklinks);
  const [unlinked, setUnlinked] = useState<NoteLite[] | null>(null);
  const [title, setTitle] = useState(initialNote.title);
  // Lazy initialisers - splitTags re-scans the whole body, so it must run once per
  // mounted note, not on every render.
  const [tags, setTags] = useState<string[]>(() => splitTags(initialNote.tags, initialNote.contentText).explicit);
  const [bodyTags, setBodyTags] = useState<string[]>(() => extractHashtags(initialNote.contentText));
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  // The outline rail used to render unconditionally, visible only at ≥1200px via a
  // media query - so it was a panel with no control. It is a toggle in the action bar
  // now, defaulting to on so wide screens behave exactly as they did before. The media
  // query still decides whether there is ROOM for it; this decides whether it exists.
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [unresolvedComments, setUnresolvedComments] = useState(0);
  const [findMode, setFindMode] = useState<FindReplaceMode | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<'photo' | 'slides' | 'transcript'>('photo');
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  // Availability, not just preference - see lib/aiStatus. With no reachable gateway
  // the AI menu and assistant panel would render as live controls that always fail.
  const aiOn = useAiAvailable();
  const [flashcardStep, setFlashcardStep] = useState(false);
  const [flashcardBanner, setFlashcardBanner] = useState<number | null>(null);
  // Summarise is the ONLY AI action left that previews a whole-note result. It inserts a
  // callout rather than rewriting the note, so there is nothing to diff and nothing to
  // review per change; Improve and Clean both go through the review rail instead.
  const [summaryResult, setSummaryResult] = useState<{ model: string; markdown: string } | null>(null);
  // Whether the review rail is on screen. The suggestions themselves live in the editor's
  // own plugin state (AiReviewPlugin.ts), not here: they are positional, and positions
  // belong to the document, not to a React render.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  // Stylus annotation layer over this document. Off by default: it swallows
  // pointer input over the note, so it must always be a deliberate choice.
  const [inkOpen, setInkOpen] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  // The restore point for the review currently on screen: one per RUN, not one per approval.
  // Null means "this run has not written anything yet"; a run reaching its first approval
  // fills it in and every later approval reuses it. See `snapshotBeforeReview`.
  const reviewSnapshotRef = useRef<Promise<void> | null>(null);
  const insertBtnRef = useRef<HTMLButtonElement>(null);
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  // Ink is stored relative to THIS element's top-left, so annotations stay pinned
  // to the text they mark up as the page scrolls or the window is resized.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  // Mirrors of the tag state, for the same reason titleRef exists: capturePending is a
  // stable callback (empty deps) and must read the LATEST tags without being rebuilt.
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const bodyTagsRef = useRef(bodyTags);
  bodyTagsRef.current = bodyTags;
  // Read from the keydown handler below, which is bound once (empty dep array) - a ref keeps
  // it seeing the latest findMode without re-subscribing the window listener every toggle.
  const findModeRef = useRef<FindReplaceMode | null>(findMode);
  findModeRef.current = findMode;

  // Snapshot of the latest editable content, refreshed on every title/doc change.
  // The autosave flush reads THIS (not the live editor) so a pending save still
  // completes on blur/unmount even after the editor instance has been torn down
  // (e.g. the user inserts a wikilink and immediately clicks it to navigate away).
  const pendingRef = useRef<{ title: string; contentJson: unknown; contentText: string; tags: string[] } | null>(null);

  const capturePending = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const contentText = ed.getText({ blockSeparator: '\n' });
    // Inline #hashtags are real tags, so they are re-parsed from the body on every
    // capture and unioned with the explicit chips here - at the single point where
    // the autosave payload is built. That is what makes the two authoring routes
    // ("type #revision" / "add a chip") converge on one tags array, saved by the
    // debounce, retry and beforeunload machinery that already exists.
    const fromBody = extractHashtags(contentText);
    // Only touch React state when the set actually changed: this runs on every
    // keystroke, and a fresh array each time would re-render the chip row constantly.
    if (fromBody.join('\u0000') !== bodyTagsRef.current.join('\u0000')) {
      bodyTagsRef.current = fromBody;
      setBodyTags(fromBody);
    }
    pendingRef.current = {
      title: titleRef.current,
      contentJson: ed.getJSON(),
      contentText,
      tags: unionTags(tagsRef.current, fromBody),
    };
  }, []);

  const autosave = useAutosave(
    note.id,
    () => pendingRef.current,
    (savedNote) => {
      setNote((prev) => {
        // A save that changed the tag set changed the app-wide vocabulary too, so
        // drop the autocomplete cache - otherwise a tag you just invented stays
        // missing from the suggestions for up to its TTL.
        if (prev.tags.join(' ') !== savedNote.tags.join(' ')) invalidateTagVocabulary();
        return { ...prev, updatedAt: savedNote.updatedAt, tags: savedNote.tags };
      });
    },
  );

  // Expose this note's flush so in-editor navigation (wikilink clicks) can persist
  // pending edits before leaving.
  useEffect(() => {
    setActiveFlush(autosave.flush);
    return () => setActiveFlush(null);
  }, [autosave.flush]);

  // Publish this note's notebook so Ctrl+N / '+' / quick-switcher-create file new notes
  // into the notebook you're actually reading (fix 14).
  useEffect(() => {
    setActiveNotebook(initialNote.notebookId);
    return () => clearActiveNotebook();
  }, [initialNote.notebookId]);

  /**
   * Put the caret in the title of a brand-new note.
   *
   * Creating a note left focus on <body>, so the first thing typed after "New note"
   * went nowhere - no caret, no feedback, no text. That is the single most common
   * action in the app, and it failed in exactly the moment someone is mid-lecture.
   * It also caused its own follow-on: typing produced nothing, so people clicked
   * New note again and accumulated empty notes.
   *
   * Guarded on the note actually being empty. Focusing on every open would yank the
   * caret away from someone who came to read, and would scroll a long note back to
   * the top on mobile.
   */
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const focusedNoteRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedNoteRef.current === initialNote.id) return; // don't re-grab on re-render
    const isUntouched = !initialNote.title.trim() && !initialNote.contentText?.trim();
    if (!isUntouched) return;
    focusedNoteRef.current = initialNote.id;
    // After paint, so the input exists and TipTap has finished claiming focus itself.
    const raf = requestAnimationFrame(() => titleInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [initialNote.id, initialNote.title, initialNote.contentText]);

  // Pull fresh server content into the LIVE editor after a history restore or an import that
  // targets this open note, killing any pending/stale autosave first so it can't revert the
  // change on the next keystroke (fix 4). Without this, the toast says "restored"/"ready"
  // while the editor keeps the pre-change doc and the next autosave silently undoes it.
  const resyncFromServer = useCallback(async () => {
    await autosave.settle(); // let any in-flight save land first so the fetch sees the truth
    autosave.markClean(); // then cancel pending + failed saves before we overwrite the doc
    try {
      const { note: fresh, backlinks: bl } = await api.note(note.id);
      setNote(fresh);
      setBacklinks(bl);
      setTitle(fresh.title);
      titleRef.current = fresh.title;
      const ed = editorRef.current;
      if (ed && !ed.isDestroyed) {
        ed.commands.setContent(fresh.contentJson as Record<string, unknown>, { emitUpdate: false });
      }
      // Re-seed the autosave snapshot from the fresh content so a later flush sends this,
      // not the stale pre-restore doc. Tags are re-split from the restored body for the
      // same reason: a restore can add or remove #hashtags, and the chip row must follow.
      const split = splitTags(fresh.tags, fresh.contentText);
      tagsRef.current = split.explicit;
      setTags(split.explicit);
      bodyTagsRef.current = split.fromBody;
      setBodyTags(split.fromBody);
      pendingRef.current = {
        title: fresh.title,
        contentJson: fresh.contentJson,
        contentText: fresh.contentText,
        tags: unionTags(split.explicit, split.fromBody),
      };
      api.unlinkedMentions(note.id).then((r) => setUnlinked(r.notes)).catch(() => {});
    } catch {
      toast('Could not refresh the note. Reload to see the latest', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    api
      .unlinkedMentions(note.id)
      .then((r) => setUnlinked(r.notes))
      .catch(() => setUnlinked([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  useEffect(() => {
    document.title = `${title || 'Untitled'} · Unote`;
  }, [title]);

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      // Esc closes the find bar even when focus isn't inside its own input (e.g. the user
      // clicked back into the editor while it was open).
      if (findModeRef.current && e.key === 'Escape') {
        e.preventDefault();
        setFindMode(null);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void manualSnapshot();
        return;
      }
      // Ctrl/Cmd+F and +H are bound HERE (window-scoped, only while this note page is
      // mounted) rather than in buildExtensions.ts/FolioEditor.tsx's editorProps/keymap -
      // those are editor-blocks' files this wave, not ours. A page-level listener also
      // naturally satisfies "editor focused-or-page" (e.g. focus sitting in the title
      // input still opens find) without touching lib/useShortcuts.ts.
      if (key === 'f') {
        e.preventDefault();
        setFindMode('find');
        return;
      }
      if (key === 'h') {
        e.preventDefault();
        setFindMode('replace');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function manualSnapshot() {
    await autosave.flush();
    try {
      await api.snapshot(note.id);
      toast('Snapshot saved', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Snapshot failed', 'error');
    }
  }

  function handleEditorReady(editor: Editor) {
    editorRef.current = editor;
    // Attach the find/replace ProseMirror plugin directly to this editor instance -
    // registerPlugin() is how we add it without needing a slot in buildExtensions.ts's
    // shared extensions array (editor-blocks' file). Guard against double-registration:
    // React 18 StrictMode's mount→cleanup→mount can call this twice for the same editor.
    if (!FindReplacePluginKey.get(editor.state)) {
      editor.registerPlugin(createFindReplacePlugin());
    }
    // Same registerPlugin route (and the same StrictMode double-mount guard) for the
    // inline #hashtag decorations - see HashtagExtension.ts for why it lives here
    // rather than in buildExtensions.ts's shared array.
    if (!HashtagPluginKey.get(editor.state)) {
      editor.registerPlugin(createHashtagPlugin(openTag));
    }
    // And the AI review decorations, third of the same kind. Registered unconditionally
    // (not only when a review starts) so the plugin is already in the editor's state when
    // `setReviewEdits` dispatches - and behind the same StrictMode guard, because a second
    // registration would replace the plugin instance and take a review in progress with it.
    if (!AiReviewPluginKey.get(editor.state)) {
      editor.registerPlugin(createAiReviewPlugin());
    }
    capturePending();
    setWordCount(editor.storage.characterCount?.words() ?? 0);
    setCharCount(editor.storage.characterCount?.characters() ?? 0);
  }
  function handleEditorDestroy() {
    editorRef.current = null;
  }
  function handleDocChange() {
    capturePending();
    autosave.schedule();
    const ed = editorRef.current;
    if (ed) {
      setWordCount(ed.storage.characterCount?.words() ?? 0);
      setCharCount(ed.storage.characterCount?.characters() ?? 0);
    }
  }

  function handleTitleChange(e: ChangeEvent<HTMLInputElement>) {
    setTitle(e.target.value);
    titleRef.current = e.target.value;
    capturePending();
    autosave.schedule();
  }
  function handleTitleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      editorRef.current?.commands.focus('start');
    }
  }

  /** A chip was added or removed - same dirty/debounce path a keystroke takes, so
   *  tag edits inherit the retry, the flush-on-blur and the beforeunload keepalive
   *  instead of racing them with a PATCH of their own. */
  function handleTagsChange(next: string[]) {
    tagsRef.current = next; // set before capturePending, which reads the ref
    setTags(next);
    capturePending();
    autosave.schedule();
  }

  /** Chip / Ctrl+clicked #hashtag → that tag's filtered view on the tags page. */
  function openTag(tag: string) {
    navigate(`/tags?tag=${encodeURIComponent(tag)}`);
  }

  async function togglePin() {
    const next = !note.pinned;
    setNote((n) => ({ ...n, pinned: next }));
    try {
      await api.updateNote(note.id, { pinned: next });
    } catch {
      setNote((n) => ({ ...n, pinned: !next }));
      toast('Could not update pin', 'error');
    }
  }

  function aiError(e: unknown) {
    if (e instanceof ApiError && e.status === 502) toast('AI offline. Is the gateway running?', 'error');
    else toast(e instanceof Error ? e.message : 'AI request failed', 'error');
  }

  /**
   * Put a finished run on screen.
   *
   * Shared by all three review actions, so the "nothing found", "some of it didn't run" and
   * "start a fresh restore point" decisions are made once rather than three times.
   *
   * `requested` is how many families the run was asked for. Families whose model request
   * failed are absent from `ranFamilies`, and saying so is the difference between "there was
   * nothing to find" and "we did not actually look" - which a student reading "no
   * suggestions" would otherwise have no way to tell apart.
   */
  function startReview(res: AiSuggestResult, requested: number) {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    if (res.edits.length === 0) {
      toast('Nothing to suggest - this note reads well', 'ok');
      return;
    }
    // A new run is a new undo point. Clearing this here (rather than when the rail closes)
    // means the snapshot belongs to the run that is about to be reviewed, whatever ended
    // the previous one.
    reviewSnapshotRef.current = null;
    setReviewEdits(ed.view, res.edits);
    setReviewOpen(true);
    const missed = requested - res.ranFamilies.length;
    if (missed > 0) toast(`${missed} of ${requested} checks didn't run`, 'error');
  }

  /**
   * Improve writing / Clean up formatting: a per-change review, not a rewritten note.
   *
   * This is the route `POST /api/ai/suggest` exists for. It runs one model request per
   * check family the notebook has enabled and comes back with individually approvable
   * edits, each carrying the model's own reason - which is what the rail renders and what
   * the old whole-note preview modal could never show, because a text diff can say what
   * changed but never why.
   *
   * Both menu items run the notebook's saved selection, which is where the two used to
   * differ and no longer do: "improve the writing" and "clean up the formatting" were two
   * fixed whole-note prompts, and the picker replaces both with a selection the student
   * owns per notebook. The families come from the catalogue the server serves (see
   * lib/checksApi.ts); nothing here holds a second copy of the check list.
   */
  async function runSuggestionReview(kind: 'improve' | 'clean', close: () => void) {
    close();
    setAiBusy(kind);
    try {
      const catalogue = await fetchCheckCatalogue();
      const families = resolveFamilies(note.notebookId, catalogue);
      if (families.length === 0) {
        toast('No checks are enabled for this notebook', 'error');
        return;
      }
      startReview(await api.aiSuggest(note.id, families), families.length);
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }

  /**
   * Find missing content from uploads: the note against its own imports.
   *
   * `POST /api/ai/gaps/edits`, NOT `POST /api/ai/gaps` - the latter predates this feature
   * and answers the Assistant panel with advisory markdown, which the rail cannot render.
   * One request, one family (missing-content), and every edit it returns is an insert, so
   * this action can add what a slide covered and never rewrite the student's own words.
   */
  async function handleGaps(close: () => void) {
    close();
    setAiBusy('gaps');
    try {
      startReview(await api.aiGapEdits(note.id), 1);
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }

  async function handleSummarize(close: () => void) {
    close();
    setAiBusy('summarize');
    try {
      const res = await api.aiSummarize(note.id);
      setSummaryResult({ model: res.model, markdown: res.markdown });
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }
  async function handleTitleSuggest(close: () => void) {
    close();
    setAiBusy('title');
    try {
      const res = await api.aiTitle(note.id);
      setTitle(res.title);
      titleRef.current = res.title;
      capturePending();
      autosave.schedule();
      toast('Title updated', 'ok');
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }
  async function handleFlashcards(count: number, close: () => void) {
    setFlashcardStep(false);
    close();
    setAiBusy('flashcards');
    try {
      const res = await api.aiFlashcards(note.id, count);
      setFlashcardBanner(res.cards.length);
      window.setTimeout(() => setFlashcardBanner(null), 7000);
    } catch (e) {
      aiError(e);
    } finally {
      setAiBusy(null);
    }
  }

  /**
   * The undo path for a whole review.
   *
   * A review has no Undo of its own: approvals go into the document one at a time, autosave
   * persists them, and by the time a student decides they preferred their own wording there
   * is nothing left to press. History is the answer, and this is what puts an entry in it -
   * ONE entry, taken before the first approval of a run writes anything, so restoring it
   * rewinds the entire review rather than one arbitrary suggestion.
   *
   * Three things this has to get right, all of them load-bearing:
   *
   *  • ONCE PER RUN. The promise is cached in a ref, so eight approvals await the same
   *    request and History gets one restore point instead of eight indistinguishable ones.
   *  • BEFORE THE FIRST MUTATION. The rail awaits this before it dispatches an approval
   *    (see AiReviewRail's `beforeApply`). A snapshot taken after the edit records the
   *    reviewed note and is worse than no snapshot at all, because History would then
   *    offer an entry that restores nothing.
   *  • FLUSHED FIRST. `api.snapshot` copies what the SERVER holds, not what is on screen,
   *    so a pending autosave has to land first or the restore point would be missing
   *    whatever the student typed since the last save - and restoring it would lose their
   *    typing along with the review.
   *
   * A failed snapshot does not block the approval - refusing to apply a suggestion because
   * a history write failed would be a strange thing to do to someone mid-review - but it is
   * said out loud, and the ref is cleared so the next approval tries again rather than
   * leaving the run permanently un-undoable on one transient failure.
   */
  function snapshotBeforeReview(): Promise<void> {
    if (!reviewSnapshotRef.current) {
      reviewSnapshotRef.current = autosave
        .flush()
        .then(() => api.snapshot(note.id, 'Before AI review'))
        .then(() => undefined)
        .catch(() => {
          reviewSnapshotRef.current = null;
          toast("Couldn't save a restore point, so History won't have an undo for this review", 'error');
        });
    }
    return reviewSnapshotRef.current;
  }

  /** Assistant "Add to note": append the gap analysis as a callout at the end -
   *  the ONLY way the assistant ever writes into a note, and the student clicked it. */
  function insertAssistantNotes(markdown: string) {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const bodyHtml = markdownToSafeHtml(markdown);
    const calloutHtml = `<div data-type="callout" data-emoji="🧭" data-tone="info"><h2>Assistant: gaps to fill</h2>${bodyHtml}</div>`;
    ed.chain().focus('end').insertContent(calloutHtml).run();
  }
  function applySummary() {
    if (!summaryResult || !editorRef.current) return;
    const bodyHtml = markdownToSafeHtml(summaryResult.markdown);
    const calloutHtml = `<div data-type="callout" data-emoji="🧭" data-tone="info"><h2>Summary</h2>${bodyHtml}</div>`;
    editorRef.current.chain().focus().insertContentAt(0, calloutHtml).run();
    setSummaryResult(null);
    toast('Summary added to top of note', 'ok');
  }

  function openImport(kind: 'photo' | 'slides' | 'transcript', close: () => void) {
    close();
    setImportKind(kind);
    setImportOpen(true);
  }

  const notebook = note.notebook;
  const savedLabel =
    autosave.status === 'saving'
      ? 'Saving…'
      : autosave.status === 'error'
        ? 'Save failed'
        : autosave.savedAt
          ? `Saved · ${relativeTime(autosave.savedAt.toISOString())}`
          : '';

  return (
    <div
      className="folio-note-page"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) void autosave.flush();
      }}
    >
      <div className="folio-note-main">
        <div className="folio-note-shell" ref={shellRef}>
          <div className="folio-breadcrumb">
            <Link to={`/notebook/${notebook.id}`} className="folio-breadcrumb-notebook">
              {notebook.emoji} {notebook.name}
            </Link>
            <span className="folio-breadcrumb-sep">›</span>
            <span className="folio-breadcrumb-title">{title || 'Untitled'}</span>
          </div>

          <NoteActionBar
            note={note}
            title={title}
            wordCount={wordCount}
            charCount={charCount}
            backlinkCount={backlinks.length}
            insertButtonRef={insertBtnRef}
            insertMenuOpen={insertMenuOpen}
            onToggleInsertMenu={() => setInsertMenuOpen((v) => !v)}
            aiOn={aiOn}
            aiBusy={aiBusy}
            onImprove={(close) => void runSuggestionReview('improve', close)}
            onClean={(close) => void runSuggestionReview('clean', close)}
            onGaps={handleGaps}
            onOpenChecks={(close) => {
              close();
              setChecksOpen(true);
            }}
            onSummarize={handleSummarize}
            onSuggestTitle={handleTitleSuggest}
            onFlashcards={handleFlashcards}
            flashcardStep={flashcardStep}
            onFlashcardStep={setFlashcardStep}
            outlineOpen={outlineOpen}
            onToggleOutline={() => setOutlineOpen((v) => !v)}
            commentsOpen={commentsOpen}
            onToggleComments={() => setCommentsOpen((v) => !v)}
            unresolvedComments={unresolvedComments}
            inkOpen={inkOpen}
            onToggleInk={() => setInkOpen((v) => !v)}
            // The Ctrl/Cmd+F and +H shortcuts below still own this state; the button is
            // an additional route to it, and closing from the button unmounts
            // FindReplaceBar, whose cleanup clears the match decorations.
            findOpen={findMode !== null}
            onToggleFind={() => setFindMode((m) => (m ? null : 'find'))}
            assistantOpen={assistantOpen}
            onToggleAssistant={() => setAssistantOpen((v) => !v)}
            onOpenHistory={() => setHistoryOpen(true)}
            onImport={openImport}
            onExport={() => window.open(api.exportUrl(note.id), '_blank')}
            onTogglePin={togglePin}
            infoOpen={infoOpen}
            onToggleInfo={() => setInfoOpen((v) => !v)}
            saveStatus={autosave.status}
            savedLabel={savedLabel}
            onRetrySave={() => void autosave.flush()}
          />

          {/* Placeholder is not a label - it disappears on first keystroke and is not
              reliably exposed. This is the highest-traffic input in the product. */}
          <input
            ref={titleInputRef}
            className="folio-title-input"
            aria-label="Note title"
            value={title}
            placeholder="Untitled"
            onChange={handleTitleChange}
            onKeyDown={handleTitleKeyDown}
          />

          <TagEditor tags={tags} autoTags={bodyTags} onChange={handleTagsChange} onOpenTag={openTag} />

          <AttachmentStrip attachments={note.attachments} />

          <FolioEditor
            content={note.contentJson}
            notebookId={note.notebookId}
            onReady={handleEditorReady}
            onDestroy={handleEditorDestroy}
            onDocChange={handleDocChange}
            onOutline={setOutline}
          />

          <section className="folio-links-section" data-testid="backlinks-section">
            <h4>Linked from {plural(backlinks.length, 'note')}</h4>
            {backlinks.length === 0 ? (
              <p className="folio-links-empty">No notes link here yet.</p>
            ) : (
              <div className="folio-links-grid">
                {backlinks.map((n) => (
                  <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
                ))}
              </div>
            )}
          </section>

          {unlinked != null && unlinked.length > 0 && (
            <section className="folio-links-section">
              <h4>Unlinked mentions</h4>
              <div className="folio-links-grid">
                {unlinked.map((n) => (
                  <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <NoteInkOverlay noteId={note.id} anchorRef={shellRef} open={inkOpen} onClose={() => setInkOpen(false)} />

      {insertMenuOpen && editorRef.current && (
        <InsertMenuPopover editor={editorRef.current} anchor={insertBtnRef.current} onClose={() => setInsertMenuOpen(false)} />
      )}

      {outlineOpen && <OutlinePane items={outline} editor={editorRef.current} />}

      {/* Mounted directly beside the note for now. The chrome plan's NoteDock does not exist
          yet, and a rail that only appears while a review is running is not a panel the dock
          would toggle anyway - a later task moves it in. */}
      {reviewOpen && editorRef.current && (
        <AiReviewRail
          editor={editorRef.current}
          beforeApply={snapshotBeforeReview}
          onDone={() => setReviewOpen(false)}
        />
      )}

      {/* Per notebook, not per note: a chemistry notebook and an essay notebook want
          different checks, and every note in one of them wants the same ones. */}
      <CheckPicker notebookId={note.notebookId} open={checksOpen} onClose={() => setChecksOpen(false)} />

      <HistoryPanel noteId={note.id} open={historyOpen} onClose={() => setHistoryOpen(false)} onRestored={resyncFromServer} />

      <CommentsPanel
        noteId={note.id}
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        editor={editorRef.current}
        onUnresolvedCountChange={setUnresolvedComments}
      />

      {findMode && editorRef.current && (
        <FindReplaceBar
          key={note.id}
          editor={editorRef.current}
          mode={findMode}
          onModeChange={setFindMode}
          onClose={() => setFindMode(null)}
        />
      )}

      <AssistantPanel
        noteId={note.id}
        attachments={note.attachments}
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        onInsert={insertAssistantNotes}
      />

      {/* The last whole-note preview, and the only one that was ever right: a summary is
          new text going in at the top, so there is no "before" to diff it against and
          nothing to approve change by change. Improve and Clean used to share this modal
          and a `before` truncated to 600 characters - a comparison that was silently
          incomplete for any note longer than a paragraph. Both go through the review rail
          now, and the truncation went with them. */}
      {summaryResult && (
        <AiPreviewModal
          open
          onClose={() => setSummaryResult(null)}
          heading="AI: Summarize"
          model={summaryResult.model}
          afterMarkdown={summaryResult.markdown}
          actions={[{ label: 'Insert summary', primary: true, onClick: applySummary }]}
        />
      )}

      {flashcardBanner != null && (
        <div className="folio-flashcard-banner">
          {flashcardBanner} flashcards added.{' '}
          <Link to="/study" onClick={() => setFlashcardBanner(null)}>
            Study now →
          </Link>
        </div>
      )}

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        noteId={note.id}
        defaultKind={importKind}
        onImported={(resultNoteId) => {
          // The import merged/appended into THIS open note - pull the server's new content
          // into the live editor so the next autosave doesn't revert it (fix 4).
          if (resultNoteId === note.id) void resyncFromServer();
        }}
      />
    </div>
  );
}

function AttachmentStrip({ attachments }: { attachments?: Attachment[] }) {
  const items = (attachments ?? []).filter((a) => a.status !== 'failed');
  if (items.length === 0) return null;
  const isImage = (a: Attachment) => a.mime.startsWith('image/') || a.kind === 'photo' || a.kind === 'image';
  return (
    <div className="folio-attachments" aria-label="Original source files">
      {items.map((a) =>
        isImage(a) ? (
          <a key={a.id} className="folio-attachment folio-attachment--photo" href={a.url} target="_blank" rel="noopener noreferrer" title={`Open original: ${a.originalName}`}>
            <img src={a.url} alt={a.originalName} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} className="folio-attachment folio-attachment--file" href={a.url} target="_blank" rel="noopener noreferrer" title={`Open original: ${a.originalName}`}>
            <Icon name="file-text" size={16} />
            <span className="folio-attachment__name">{a.originalName}</span>
            <span className="folio-attachment__size">{formatBytes(a.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}
