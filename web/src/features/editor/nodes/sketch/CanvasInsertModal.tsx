// "Insert from canvas" — pick one of your boards and drop a static snapshot of it into the
// note as an image figure. Mounted imperatively by canvasInsertInsertable.ts (no shared
// modal host required), the same self-contained pattern as templates/saveAsTemplate.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import Modal from '../../../../components/Modal';
import Icon from '../../../../components/Icon';
import { toast } from '../../../../components/Toast';
import { api } from '../../../../lib/api';
import type { NoteLite } from '../../../../lib/types';
import {
  boardIsEmpty,
  loadBoard,
  renderBoardToDataUrl,
  renderBoardToPngBlob,
  type BoardData,
} from './boardSnapshot';

interface CanvasInsertModalProps {
  editor: Editor;
  onDone: () => void;
}

export default function CanvasInsertModal({ editor, onDone }: CanvasInsertModalProps) {
  const [boards, setBoards] = useState<NoteLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);

  // Board data loaded by the cards, reused by the insert step so it isn't fetched twice.
  const cacheRef = useRef<Map<string, BoardData>>(new Map());

  useEffect(() => {
    let live = true;
    api
      .notes({ sort: 'updated', limit: 200 })
      .then(({ notes }) => {
        if (!live) return;
        setBoards(notes.filter((n) => n.kind === 'canvas'));
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : 'Could not load your boards');
      });
    return () => {
      live = false;
    };
  }, []);

  const onCardLoaded = useCallback((id: string, data: BoardData) => {
    cacheRef.current.set(id, data);
  }, []);

  const selectedBoard = boards?.find((b) => b.id === selectedId) ?? null;

  const insert = useCallback(async () => {
    if (!selectedBoard) return;
    setBusy(true);
    try {
      const data = cacheRef.current.get(selectedBoard.id) ?? (await loadBoard(selectedBoard.id));
      if (boardIsEmpty(data)) {
        toast('That board is empty, so there is nothing to snapshot', 'error');
        setBusy(false);
        return;
      }
      const { blob } = await renderBoardToPngBlob(data, { scale: 2 });
      const form = new FormData();
      form.append('file', new File([blob], `${slug(selectedBoard.title)}-snapshot.png`, { type: 'image/png' }));
      const { url } = await api.uploadImage(form);

      const alt = `Snapshot of ${selectedBoard.title || 'canvas board'}`;
      const chain = editor.chain().focus().setImage({ src: url, alt });
      const cap = caption.trim();
      if (cap) chain.insertContent({ type: 'paragraph', content: [{ type: 'text', text: cap }] });
      chain.run();

      toast('Canvas snapshot inserted', 'info', { durationMs: 1600 });
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not insert the snapshot', 'error');
      setBusy(false);
    }
  }, [selectedBoard, editor, caption, onDone]);

  return (
    <Modal open onClose={onDone} title="Insert from canvas" width={720}>
      <div className="sk-picker">
        {error && <p className="sk-picker__msg sk-picker__msg--error">{error}</p>}
        {!error && boards === null && <p className="sk-picker__msg">Loading your boards…</p>}
        {!error && boards !== null && boards.length === 0 && (
          <div className="sk-picker__empty">
            <Icon name="canvas" size={28} />
            <p>No canvas boards yet. Create a board first, then insert a snapshot of it here.</p>
          </div>
        )}

        {boards && boards.length > 0 && (
          <ul className="sk-picker__grid" role="listbox" aria-label="Your canvas boards">
            {boards.map((b) => (
              <BoardCard
                key={b.id}
                note={b}
                selected={b.id === selectedId}
                onSelect={() => setSelectedId(b.id)}
                onLoaded={onCardLoaded}
              />
            ))}
          </ul>
        )}
      </div>

      {boards && boards.length > 0 && (
        <div className="sk-picker__foot">
          <input
            className="sk-picker__caption"
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder={selectedBoard ? `Caption (optional) — e.g. ${selectedBoard.title}` : 'Caption (optional)'}
            aria-label="Caption for the snapshot"
            disabled={!selectedBoard || busy}
          />
          <div className="sk-picker__actions">
            <button type="button" className="sk-btn" onClick={onDone} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="sk-btn sk-btn--primary"
              onClick={insert}
              disabled={!selectedBoard || busy}
            >
              {busy ? 'Inserting…' : 'Insert snapshot'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface BoardCardProps {
  note: NoteLite;
  selected: boolean;
  onSelect: () => void;
  onLoaded: (id: string, data: BoardData) => void;
}

function BoardCard({ note, selected, onSelect, onLoaded }: BoardCardProps) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let live = true;
    loadBoard(note.id)
      .then(async (data) => {
        if (!live) return;
        onLoaded(note.id, data);
        if (boardIsEmpty(data)) {
          setState('empty');
          return;
        }
        // Small, cheap preview — the real insert renders at full scale.
        const url = await renderBoardToDataUrl(data, { scale: 0.5, padding: 24, maxDim: 480 });
        if (!live) return;
        setThumb(url);
        setState('ready');
      })
      .catch(() => {
        if (live) setState('error');
      });
    return () => {
      live = false;
    };
  }, [note.id, onLoaded]);

  const disabled = state === 'empty' || state === 'error';

  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        className={`sk-card${selected ? ' is-selected' : ''}`}
        onClick={onSelect}
        disabled={disabled}
        aria-label={`${note.title || 'Untitled board'}${disabled ? ' (empty)' : ''}`}
      >
        <span className="sk-card__thumb">
          {thumb ? (
            <img src={thumb} alt="" />
          ) : (
            <span className="sk-card__ph">{state === 'loading' ? 'Rendering…' : state === 'empty' ? 'Empty' : 'Unavailable'}</span>
          )}
        </span>
        <span className="sk-card__title">{note.title || 'Untitled board'}</span>
      </button>
    </li>
  );
}

function slug(title: string): string {
  return (title || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';
}
