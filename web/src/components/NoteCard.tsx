// web-shell — the required signature is exactly { note, onClick }; `compact`
// and `controls` are additive optional props (backward compatible) so
// NotebookPage can render pin/⋯ controls without NoteCard knowing any
// business logic about pin/duplicate/move/delete itself.
import type { KeyboardEvent, ReactNode } from 'react';
import type { NoteLite } from '../lib/types';
import { plural, relativeTime } from '../lib/format';
import Icon from './Icon';

export default function NoteCard({
  note,
  onClick,
  compact = false,
  controls,
  testId,
}: {
  note: NoteLite;
  onClick: () => void;
  compact?: boolean;
  controls?: ReactNode;
  testId?: string;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      className={`note-card${compact ? ' note-card--compact' : ''}`}
      role="button"
      tabIndex={0}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {!compact && (
        <div className="note-card__top">
          <span className="note-card__notebook-dot" style={{ background: note.notebook?.color }} />
          <span aria-hidden="true">{note.notebook?.emoji}</span>
          <span className="note-card__notebook-name">{note.notebook?.name}</span>
          {note.pinned && (
            <span className="note-card__pin" aria-label="Pinned">
              <Icon name="pin-filled" size={12} />
            </span>
          )}
        </div>
      )}

      <div className="note-card__main">
        <div className="note-card__title">{note.title || 'Untitled'}</div>
        <div className="note-card__snippet">{note.snippet || 'No content yet'}</div>
        <div className="note-card__meta">
          {compact && note.pinned && (
            <span aria-label="Pinned" style={{ color: 'var(--accent)', display: 'inline-flex' }}>
              <Icon name="pin-filled" size={11} />
            </span>
          )}
          <span>{relativeTime(note.updatedAt)}</span>
          <span>{plural(note.wordCount, 'word')}</span>
          {note.tags.length > 0 && (
            <span className="note-card__tags">
              {note.tags.slice(0, compact ? 3 : 2).map((t) => (
                <span key={t} className="tag-pill">#{t}</span>
              ))}
              {note.tags.length > (compact ? 3 : 2) && (
                <span className="tag-pill">+{note.tags.length - (compact ? 3 : 2)}</span>
              )}
            </span>
          )}
        </div>
      </div>

      {controls && (
        <div
          className="note-card__controls"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {controls}
        </div>
      )}
    </div>
  );
}
