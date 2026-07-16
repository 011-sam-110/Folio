// NodeView for a resolved [[Wikilink]]: accent link, click navigates via the router,
// hover shows a lazily-fetched preview card.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import type { Note } from '../../lib/types';
import Spinner from '../../components/Spinner';
import { getCachedNote, setCachedNote } from './wikilinkCache';
import { flushActiveNote } from './autosaveBus';

export default function WikilinkView({ node }: NodeViewProps) {
  const navigate = useNavigate();
  const noteId = (node.attrs.noteId as string) || null;
  const label = (node.attrs.alias || node.attrs.title || 'Untitled') as string;

  const [show, setShow] = useState(false);
  const [preview, setPreview] = useState<Note | null>(() => (noteId ? getCachedNote(noteId) ?? null : null));
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
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

  async function handleClick(e: MouseEvent) {
    e.preventDefault();
    if (!noteId) return;
    // Persist any pending edit to the current note (e.g. the link just created)
    // before navigating, so the destination's backlinks/content reflect it.
    await flushActiveNote();
    navigate(`/note/${noteId}`);
  }

  return (
    <NodeViewWrapper as="span" className="folio-wikilink-wrap" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <a
        href={noteId ? `/note/${noteId}` : '#'}
        className="folio-wikilink"
        data-note-id={noteId ?? ''}
        onClick={handleClick}
        contentEditable={false}
      >
        {label}
      </a>
      {show && (
        <span className="folio-wikilink-preview" contentEditable={false}>
          {loading && !preview ? (
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
