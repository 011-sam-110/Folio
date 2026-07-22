// NodeView for a [[Wikilink]]: accent link, click navigates via the router,
// hover shows a lazily-fetched preview card. Unresolved links (noteId == null - e.g. from
// an import whose target doesn't exist yet) get a distinct 'missing' style and clicking
// one offers to create the note.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import type { Note } from '../../lib/types';
import Spinner from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { getCachedNote, setCachedNote } from './wikilinkCache';
import { flushActiveNote } from './autosaveBus';
import type { WikilinkOptions } from './WikilinkExtension';

export default function WikilinkView({ node, extension, updateAttributes }: NodeViewProps) {
  const navigate = useNavigate();
  const noteId = (node.attrs.noteId as string) || null;
  const title = (node.attrs.title as string) || 'Untitled';
  const label = (node.attrs.alias || node.attrs.title || 'Untitled') as string;

  const [show, setShow] = useState(false);
  const [preview, setPreview] = useState<Note | null>(() => (noteId ? getCachedNote(noteId) ?? null : null));
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [creating, setCreating] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function handleEnter() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      setShow(true);
      if (!noteId) return;
      const cached = getCachedNote(noteId);
      if (cached) {
        setPreview(cached);
        return;
      }
      setLoading(true);
      try {
        const res = await api.note(noteId);
        setCachedNote(noteId, res.note);
        setPreview(res.note);
      } catch {
        setMissing(true);
      } finally {
        setLoading(false);
      }
    }, 350);
  }

  function handleLeave() {
    window.clearTimeout(timer.current);
    setShow(false);
  }

  async function createTarget() {
    if (creating) return;
    const notebookId = (extension.options as WikilinkOptions).getNotebookId();
    if (!notebookId) {
      toast('Could not determine which notebook to create the note in', 'error');
      return;
    }
    setCreating(true);
    try {
      const { note } = await api.createNote({ notebookId, title });
      try {
        updateAttributes({ noteId: note.id, title: note.title });
      } catch {
        // read-only host (e.g. history preview) - navigation below still works
      }
      toast(`Created "${note.title}"`, 'ok');
      await flushActiveNote();
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create note', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleClick(e: MouseEvent) {
    e.preventDefault();
    if (!noteId) {
      // Unresolved link - offer to create the target note.
      if (window.confirm(`"${title}" doesn't exist yet. Create it?`)) void createTarget();
      return;
    }
    // Persist any pending edit to the current note (e.g. the link just created)
    // before navigating, so the destination's backlinks/content reflect it.
    await flushActiveNote();
    navigate(`/note/${noteId}`);
  }

  const isMissing = !noteId;

  return (
    <NodeViewWrapper as="span" className="folio-wikilink-wrap" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <a
        href={noteId ? `/note/${noteId}` : '#'}
        className={`folio-wikilink${isMissing ? ' folio-wikilink--missing' : ''}`}
        data-note-id={noteId ?? ''}
        data-missing={isMissing || undefined}
        title={isMissing ? `"${title}" doesn't exist yet. Click to create it` : undefined}
        onClick={handleClick}
        contentEditable={false}
      >
        {label}
      </a>
      {show && (
        <span className="folio-wikilink-preview" contentEditable={false}>
          {isMissing ? (
            <>
              <span className="folio-wikilink-preview-snip">This note doesn't exist yet.</span>
              <button type="button" className="folio-wikilink-preview-create" disabled={creating} onClick={() => void createTarget()}>
                {creating ? 'Creating…' : `Create "${title}"`}
              </button>
            </>
          ) : loading && !preview ? (
            <Spinner size={14} />
          ) : preview ? (
            <>
              <strong>{preview.title || 'Untitled'}</strong>
              <span className="folio-wikilink-preview-notebook">
                {preview.notebook.emoji} {preview.notebook.name}
              </span>
              <span className="folio-wikilink-preview-snip">{(preview.contentText || '').slice(0, 140) || 'Empty note'}</span>
            </>
          ) : missing ? (
            <span className="folio-wikilink-preview-snip">Note not found</span>
          ) : null}
        </span>
      )}
    </NodeViewWrapper>
  );
}
