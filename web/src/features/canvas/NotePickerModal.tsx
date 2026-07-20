// "Link to note" picker. Search-first rather than a long list: a student with 200
// notes cannot scan a dropdown, and title search is already an endpoint.

import { useEffect, useRef, useState } from 'react';
import Modal from '../../components/Modal';
import Icon from '../../components/Icon';
import Spinner from '../../components/Spinner';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import type { TitleResult } from '../../lib/types';

export interface NotePickerModalProps {
  open: boolean;
  onClose: () => void;
  onPick: (note: { id: string; title: string }) => void;
}

export default function NotePickerModal({ open, onClose, onPick }: NotePickerModalProps) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TitleResult[]>([]);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setResults([]);
  }, [open]);

  // 220ms debounce, and a monotonic sequence so a slow early query cannot land
  // after a faster later one and show stale results.
  useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      const p = q.trim() ? api.searchTitles(q.trim(), 12) : api.recentNotes(12).then((r) => ({
        results: r.notes.map((n) => ({ id: n.id, title: n.title, notebook: n.notebook, updatedAt: n.updatedAt })),
      }));
      p
        .then((r) => {
          if (seqRef.current !== seq) return;
          setResults(r.results);
          setLoading(false);
        })
        .catch(() => {
          if (seqRef.current !== seq) return;
          setResults([]);
          setLoading(false);
        });
    }, 220);
    return () => window.clearTimeout(t);
  }, [q, open]);

  return (
    <Modal open={open} onClose={onClose} title="Link a note" width={520}>
      <div className="cv-picker">
        <input
          className="cv-picker__input"
          placeholder="Search notes by title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search notes by title"
        />
        {loading && results.length === 0 ? (
          <div className="cv-picker__state">
            <Spinner />
          </div>
        ) : results.length === 0 ? (
          <div className="cv-picker__state">No notes match that.</div>
        ) : (
          <ul className="cv-picker__list">
            {results.map((r) => (
              <li key={r.id}>
                <button type="button" className="cv-picker__row" onClick={() => onPick({ id: r.id, title: r.title || 'Untitled' })}>
                  <span className="cv-picker__emoji" aria-hidden="true">
                    {r.notebook?.emoji ?? <Icon name="file-text" size={14} />}
                  </span>
                  <span className="cv-picker__name">{r.title || 'Untitled'}</span>
                  <span className="cv-picker__meta">{relativeTime(r.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
