// All-cards management table. NOTE: the only per-card listing endpoint the
// API contract exposes is GET /api/study/queue (due + not-suspended cards,
// per docs/API.md), so this is the best available data source for "all
// cards" — fetched with a generous limit rather than the review-sized 20.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Flashcard, StudyStats } from '../../lib/types';
import { toast } from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import { relativeTime } from '../../lib/format';
import './StudyPage.css';

const BROWSE_LIMIT = 500;

type RowState = 'idle' | 'editing' | 'confirmDelete';

export default function BrowseTab({ stats, onChanged }: { stats: StudyStats | null; onChanged: () => void }) {
  const [cards, setCards] = useState<Flashcard[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [draft, setDraft] = useState<{ question: string; answer: string }>({ question: '', answer: '' });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCards(null);
    setError(false);
    try {
      const res = await api.studyQueue(BROWSE_LIMIT);
      setCards(res.cards);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function startEdit(card: Flashcard) {
    setExpandedId(card.id);
    setDraft({ question: card.question, answer: card.answer });
    setRowState(s => ({ ...s, [card.id]: 'editing' }));
  }

  function resetRow(id: string) {
    setRowState(s => ({ ...s, [id]: 'idle' }));
  }

  async function saveEdit(id: string) {
    if (!draft.question.trim() || !draft.answer.trim()) {
      toast("Question and answer can't be empty", 'error');
      return;
    }
    setBusyId(id);
    try {
      const res = await api.updateCard(id, { question: draft.question.trim(), answer: draft.answer.trim() });
      setCards(prev => prev?.map(c => (c.id === id ? res.card : c)) ?? prev);
      resetRow(id);
      toast('Card updated', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save changes', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleSuspend(card: Flashcard) {
    const next = !card.suspended;
    setBusyId(card.id);
    setCards(prev => prev?.map(c => (c.id === card.id ? { ...c, suspended: next } : c)) ?? prev);
    try {
      await api.updateCard(card.id, { suspended: next });
      onChanged();
    } catch (err) {
      setCards(prev => prev?.map(c => (c.id === card.id ? { ...c, suspended: !next } : c)) ?? prev);
      toast(err instanceof ApiError ? err.message : 'Could not update card', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete(id: string) {
    setBusyId(id);
    try {
      await api.deleteCard(id);
      setCards(prev => prev?.filter(c => c.id !== id) ?? prev);
      onChanged();
      toast('Card deleted', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete card', 'error');
    } finally {
      setBusyId(null);
    }
  }

  const filtered = (cards ?? []).filter(c => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return c.question.toLowerCase().includes(q) || c.answer.toLowerCase().includes(q) || (c.noteTitle ?? '').toLowerCase().includes(q);
  });

  if (cards === null && !error) {
    return <div className="sy-browse"><Skeleton lines={6} /></div>;
  }

  if (error) {
    return (
      <EmptyState
        icon="⚠️"
        title="Couldn't load your cards"
        hint="Check the server connection and try again."
        action={<button type="button" className="sy-btn sy-btn--primary" onClick={load}>Retry</button>}
      />
    );
  }

  return (
    <div className="sy-browse">
      <div className="sy-browse__stats">
        <div className="sy-stat-pill"><strong>{stats?.due ?? '–'}</strong> due</div>
        <div className="sy-stat-pill"><strong>{stats?.total ?? cards?.length ?? 0}</strong> total</div>
        <div className="sy-stat-pill"><strong>{stats?.reviewedToday ?? '–'}</strong> reviewed today</div>
        <input
          className="sy-browse__search"
          type="search"
          placeholder="Filter cards…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Filter flashcards"
        />
      </div>

      {cards && cards.length === 0 ? (
        <EmptyState icon="🗂️" title="No flashcards yet" hint="Generate flashcards from a note using the AI menu in the editor." />
      ) : filtered.length === 0 ? (
        <EmptyState icon="🔍" title={`No cards match "${query}"`} />
      ) : (
        <div className="sy-browse__table-wrap">
          <table className="sy-browse__table">
            <thead>
              <tr>
                <th>Question</th>
                <th>Note</th>
                <th>Due</th>
                <th>Reps</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(card => {
                const state = rowState[card.id] ?? 'idle';
                const expanded = expandedId === card.id;
                return (
                  <Fragment key={card.id}>
                    <tr className={card.suspended ? 'is-suspended' : ''}>
                      <td className="sy-browse__question" onClick={() => setExpandedId(expanded ? null : card.id)}>
                        {truncate(card.question, 90)}
                      </td>
                      <td>
                        {card.noteId ? (
                          <Link className="sy-link-btn" to={`/note/${card.noteId}`}>{card.noteTitle ?? 'Untitled'}</Link>
                        ) : (
                          <span className="sy-ink-3">—</span>
                        )}
                      </td>
                      <td>{relativeTime(card.dueAt)}</td>
                      <td>{card.reps}</td>
                      <td className="sy-browse__actions">
                        <button
                          type="button"
                          className="sy-icon-btn"
                          title={card.suspended ? 'Unsuspend' : 'Suspend'}
                          disabled={busyId === card.id}
                          onClick={() => toggleSuspend(card)}
                        >
                          {card.suspended ? '▶️' : '⏸️'}
                        </button>
                        <button type="button" className="sy-icon-btn" title="Edit" onClick={() => startEdit(card)}>✏️</button>
                        {state === 'confirmDelete' ? (
                          <span className="sy-confirm-delete">
                            <button type="button" className="sy-link-btn sy-link-btn--danger" disabled={busyId === card.id} onClick={() => confirmDelete(card.id)}>
                              Confirm
                            </button>
                            <button type="button" className="sy-link-btn" onClick={() => resetRow(card.id)}>Cancel</button>
                          </span>
                        ) : (
                          <button type="button" className="sy-icon-btn" title="Delete" onClick={() => setRowState(s => ({ ...s, [card.id]: 'confirmDelete' }))}>
                            🗑️
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="sy-browse__detail-row">
                        <td colSpan={5}>
                          {state === 'editing' ? (
                            <div className="sy-browse__edit">
                              <label>
                                Question
                                <textarea value={draft.question} onChange={e => setDraft(d => ({ ...d, question: e.target.value }))} rows={2} />
                              </label>
                              <label>
                                Answer
                                <textarea value={draft.answer} onChange={e => setDraft(d => ({ ...d, answer: e.target.value }))} rows={3} />
                              </label>
                              <div className="sy-browse__edit-actions">
                                <button type="button" className="sy-btn sy-btn--primary" disabled={busyId === card.id} onClick={() => saveEdit(card.id)}>Save</button>
                                <button type="button" className="sy-btn" onClick={() => resetRow(card.id)}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div className="sy-browse__answer"><strong>Answer:</strong> {card.answer}</div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
