// Find/replace bar docked top-right of the editor area. Drives the FindReplace.ts
// ProseMirror plugin: live match count ("n of m"), prev/next, an expandable replace row,
// Replace / Replace all. Esc closes. Bound from NotePage.tsx via Ctrl/Cmd+F (find) and
// Ctrl/Cmd+H (replace) — see NotePage.tsx for why that binding lives at the page level
// rather than in buildExtensions.ts/FolioEditor.tsx (editor-blocks' files, not ours).
import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import Icon from '../../components/Icon';
import { setQuery, clearFind, findNext, findPrev, replaceCurrent, replaceAll, getMatchState, type MatchState } from './FindReplace';

export type FindReplaceMode = 'find' | 'replace';

export interface FindReplaceBarProps {
  editor: Editor;
  mode: FindReplaceMode;
  onModeChange: (mode: FindReplaceMode) => void;
  onClose: () => void;
}

export default function FindReplaceBar({ editor, mode, onModeChange, onClose }: FindReplaceBarProps) {
  const [query, setQueryState] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchState, setMatchState] = useState<MatchState>({ total: 0, index: -1 });
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  // Keep "n of m" live as the doc changes underneath (typing elsewhere shifts/removes matches).
  useEffect(() => {
    function sync() {
      setMatchState(getMatchState(editor));
    }
    sync();
    editor.on('transaction', sync);
    return () => {
      editor.off('transaction', sync);
    };
  }, [editor]);

  // Clear decorations on unmount (close button, Esc, or the note switching under us).
  useEffect(() => {
    return () => {
      if (!editor.isDestroyed) clearFind(editor);
    };
  }, [editor]);

  function handleQueryChange(value: string) {
    setQueryState(value);
    setQuery(editor, value);
  }

  function handleClose() {
    clearFind(editor);
    onClose();
  }

  function handleReplaceOne() {
    if (!query) return;
    replaceCurrent(editor, replacement);
  }

  function handleReplaceAll() {
    if (!query) return;
    replaceAll(editor, query, replacement);
  }

  const countLabel = !query ? '' : matchState.total === 0 ? '0 of 0' : `${matchState.index + 1} of ${matchState.total}`;

  return (
    <div className="folio-find-bar" role="search" aria-label="Find and replace in note">
      <div className="folio-find-row">
        <Icon name="search" size={13} />
        <input
          ref={findInputRef}
          className="folio-find-input"
          aria-label="Find in note"
          value={query}
          placeholder="Find in note"
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) findPrev(editor);
              else findNext(editor);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handleClose();
            }
          }}
        />
        <span className="folio-find-count">{countLabel}</span>
        <button
          type="button"
          className="folio-btn-icon"
          aria-label="Previous match"
          disabled={matchState.total === 0}
          onClick={() => findPrev(editor)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          className="folio-btn-icon"
          aria-label="Next match"
          disabled={matchState.total === 0}
          onClick={() => findNext(editor)}
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <button
          type="button"
          className={`folio-btn-icon${mode === 'replace' ? ' active' : ''}`}
          aria-label={mode === 'replace' ? 'Hide replace' : 'Show replace'}
          aria-expanded={mode === 'replace'}
          onClick={() => onModeChange(mode === 'replace' ? 'find' : 'replace')}
        >
          <Icon name="chevron-down" size={14} />
        </button>
        <button type="button" className="folio-btn-icon" aria-label="Close find" onClick={handleClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      {mode === 'replace' && (
        <div className="folio-find-row folio-find-replace-row">
          <input
            className="folio-find-input"
            aria-label="Replace with"
            value={replacement}
            placeholder="Replace with"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleReplaceOne();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                handleClose();
              }
            }}
          />
          <button type="button" className="folio-btn" disabled={matchState.total === 0} onClick={handleReplaceOne}>
            Replace
          </button>
          <button type="button" className="folio-btn" disabled={matchState.total === 0} onClick={handleReplaceAll}>
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
