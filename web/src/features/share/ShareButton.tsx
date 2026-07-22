// The owner-side entry point: one button that both opens the share dialog and
// reports whether this note is currently reachable by anyone else.
//
// The share state is fetched here rather than passed in, because no notes
// endpoint returns it - /api/notes and /api/notes/:id say nothing about shares,
// so a "shared" badge on a note CARD is not currently possible without a server
// change. Within an open note it costs one cheap request, and that is where the
// author is when the answer matters.

import { useCallback, useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import { api } from '../../lib/api';
import type { NoteKind } from '../../lib/types';
import ShareDialog from './ShareDialog';
import './share.css';

export interface ShareButtonProps {
  noteId: string;
  noteTitle: string;
  kind: NoteKind;
}

export default function ShareButton({ noteId, noteTitle, kind }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .shares(noteId)
      .then(({ shares }) => {
        if (!cancelled) setCount(shares.length);
      })
      .catch(() => {
        // A failed probe just means no badge. It must never block the header.
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const onCountChange = useCallback((n: number) => setCount(n), []);

  const shared = count > 0;
  const label = shared
    ? `Shared: ${count} active ${count === 1 ? 'link' : 'links'}`
    : 'Share this ' + (kind === 'canvas' ? 'canvas' : 'note');

  return (
    <>
      <button
        type="button"
        className={`sh-btn${shared ? ' is-shared' : ''}`}
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        data-testid="share-open"
      >
        <Icon name="link" size={14} />
        {shared ? 'Shared' : 'Share'}
        {shared && <span className="sh-btn__dot" aria-hidden="true" />}
      </button>

      <ShareDialog
        open={open}
        onClose={() => setOpen(false)}
        noteId={noteId}
        noteTitle={noteTitle}
        kind={kind}
        onCountChange={onCountChange}
      />
    </>
  );
}
