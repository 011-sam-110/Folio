// All-cards management table. Uses GET /api/study/cards (per docs/API.md), which
// returns the whole deck including suspended and not-yet-due cards — the correct
// data source for a management surface (the review /queue is due-only).
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Flashcard, StudyStats } from '../../lib/types';
import { toast } from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import ConfirmDialog from '../../components/ConfirmDialog';
import Icon from '../../components/Icon';
import { formatDueIn } from './sm2';
import CardComposer from './CardComposer';
import './StudyPage.css';

type RowState = 'idle' | 'editing' | 'confirmDelete';

export default function BrowseTab({
  stats,
  onChanged,
  openComposerSignal,
}: {
  stats: StudyStats | null;
  onChanged: () => void;
  /** Bumped by StudyPage (e.g. from the Review tab's "no cards at all" empty state) to
   *  request the composer pop open even though the user is arriving fresh on this tab. */
  openComposerSignal?: number;
}) {
  const [cards, setCards] = useState<Flashcard[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [draft, setDraft] = useState<{ question: string; answer: string }>({ question: '', answer: '' });
  const [busyId, setBusyId] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [groupByNote, setGroupByNote] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setCards(null);
    setError(false);
    try {
      const res = await api.studyCards();
      setCards(res.cards);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Signal-based open so the Review tab's empty states can send the user here with the
  // composer already up (a plain callback can't distinguish "just switch tabs" from
  // "switch tabs AND start adding a card" without this).
  useEffect(() => {
    if (openComposerSignal) setComposerOpen(true);
  }, [openComposerSignal]);

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

  function onCardCreated(card: Flashcard) {
    setCards(prev => (prev ? [card, ...prev] : [card]));
    onChanged();
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = (cards ?? []).filter(c => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return c.question.toLowerCase().includes(q) || c.answer.toLowerCase().includes(q) || (c.noteTitle ?? '').toLowerCase().includes(q);
  });

  function toggleSelectAllFiltered() {
    setSelectedIds(prev => {
      const allSelected = filtered.length > 0 && filtered.every(c => prev.has(c.id));
      if (allSelected) return new Set();
      return new Set(filtered.map(c => c.id));
    });
  }

  const selectedCards = (cards ?? []).filter(c => selectedIds.has(c.id));
  const allSelectedSuspended = selectedCards.length > 0 && selectedCards.every(c => c.suspended);

  async function bulkSuspend() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const target = !allSelectedSuspended;
    setBulkBusy(true);
    const snapshot = cards;
    setCards(prev => prev?.map(c => (selectedIds.has(c.id) ? { ...c, suspended: target } : c)) ?? prev);
    try {
      await Promise.all(ids.map(id => api.updateCard(id, { suspended: target })));
      onChanged();
      toast(`${ids.length} card${ids.length === 1 ? '' : 's'} ${target ? 'suspended' : 'unsuspended'}`, 'ok');
      setSelectedIds(new Set());
    } catch (err) {
      setCards(snapshot);
      toast(err instanceof ApiError ? err.message : 'Could not update those cards', 'error');
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(ids.map(id => api.deleteCard(id)));
      setCards(prev => prev?.filter(c => !selectedIds.has(c.id)) ?? prev);
      onChanged();
      toast(`${ids.length} card${ids.length === 1 ? '' : 's'} deleted`, 'ok');
      setSelectedIds(new Set());
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete some cards — refreshing the list', 'error');
      load();
    } finally {
      setBulkBusy(false);
      setConfirmBulkDelete(false);
    }
  }

  const grouped = useMemo(() => {
    if (!groupByNote) return null;
    const map = new Map<string, { title: string; cards: Flashcard[] }>();
    for (const c of filtered) {
      const key = c.noteId ?? '__none__';
      const title = c.noteId ? (c.noteTitle ?? 'Untitled') : 'No linked note';
      if (!map.has(key)) map.set(key, { title, cards: [] });
      map.get(key)!.cards.push(c);
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, title: v.title, cards: v.cards }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [groupByNote, filtered]);

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

  function renderRow(card: Flashcard) {
    const state = rowState[card.id] ?? 'idle';
    const expanded = expandedId === card.id;
    const chip = dueChip(card);
    return (
      <Fragment key={card.id}>
        <tr className={card.suspended ? 'is-suspended' : ''}>
          <td className="sy-browse__checkbox-col">
            <input
              type="checkbox"
              aria-label={`Select card "${truncate(card.question, 40)}"`}
              checked={selectedIds.has(card.id)}
              onChange={() => toggleSelect(card.id)}
            />
          </td>
          <td className="sy-browse__question">
            <button
              type="button"
              className="sy-browse__question-btn"
              aria-expanded={expanded}
              onClick={() => setExpandedId(expanded ? null : card.id)}
            >
              {truncate(card.question, 90)}
            </button>
          </td>
          <td>
            {card.noteId ? (
              <Link className="sy-link-btn" to={`/note/${card.noteId}`}>{card.noteTitle ?? 'Untitled'}</Link>
            ) : (
              <span className="sy-ink-3">—</span>
            )}
          </td>
          <td>
            <span className={`sy-due-chip sy-due-chip--${chip.tone}`}>{chip.label}</span>
          </td>
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
            <td colSpan={6}>
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
  }

  return (
    <div className="sy-browse">
      <div className="sy-browse__stats">
        <div className="sy-stat-pill"><strong>{stats?.due ?? '–'}</strong> due</div>
        <div className="sy-stat-pill"><strong>{stats?.total ?? cards?.length ?? 0}</strong> total</div>
        <div className="sy-stat-pill"><strong>{stats?.reviewedToday ?? '–'}</strong> reviewed today</div>
        <button
          type="button"
          className="sy-btn sy-btn--primary"
          onClick={() => setComposerOpen(o => !o)}
          aria-expanded={composerOpen}
        >
          <Icon name="plus" size={14} /> New card
        </button>
        <button
          type="button"
          className={`sy-toggle-btn${groupByNote ? ' is-active' : ''}`}
          aria-pressed={groupByNote}
          onClick={() => setGroupByNote(g => !g)}
          title="Group cards by their source note"
        >
          <Icon name="layers" size={14} /> Group by note
        </button>
        <input
          className="sy-browse__search"
          type="search"
          placeholder="Filter cards…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Filter flashcards"
        />
      </div>

      {composerOpen && (
        <CardComposer
          onCreated={(card) => { onCardCreated(card); }}
          onCancel={() => setComposerOpen(false)}
        />
      )}

      {selectedIds.size > 0 && (
        <div className="sy-bulkbar" role="toolbar" aria-label="Bulk card actions">
          <span className="sy-bulkbar__count">{selectedIds.size} selected</span>
          <button type="button" className="sy-btn" disabled={bulkBusy} onClick={bulkSuspend}>
            {allSelectedSuspended ? 'Unsuspend' : 'Suspend'}
          </button>
          <button type="button" className="sy-btn sy-btn--danger" disabled={bulkBusy} onClick={() => setConfirmBulkDelete(true)}>
            Delete
          </button>
          <button type="button" className="sy-link-btn" onClick={() => setSelectedIds(new Set())}>Clear selection</button>
        </div>
      )}

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected cards?"
        message={`This permanently deletes ${selectedIds.size} card${selectedIds.size === 1 ? '' : 's'}. This can't be undone.`}
        confirmLabel="Delete"
        danger
        loading={bulkBusy}
        onConfirm={bulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      {cards && cards.length === 0 ? (
        <EmptyState
          icon="🗂️"
          title="No flashcards yet"
          hint="Select a sentence in any note and pick 'Add to flashcards' from the toolbar that appears — or write one here with New card."
          action={<button type="button" className="sy-btn sy-btn--primary" onClick={() => setComposerOpen(true)}>Add your first card</button>}
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon="🔍" title={`No cards match "${query}"`} />
      ) : (
        <div className="sy-browse__table-wrap">
          <table className="sy-browse__table">
            <thead>
              <tr>
                <th className="sy-browse__checkbox-col">
                  <input
                    type="checkbox"
                    aria-label="Select all visible cards"
                    checked={filtered.length > 0 && filtered.every(c => selectedIds.has(c.id))}
                    onChange={toggleSelectAllFiltered}
                  />
                </th>
                <th>Question</th>
                <th>Note</th>
                <th>Due</th>
                <th>Reps</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {grouped
                ? grouped.map(g => (
                    <Fragment key={g.key}>
                      <tr className="sy-browse__group-row">
                        <td colSpan={6}>{g.title} <span className="sy-ink-3">· {g.cards.length}</span></td>
                      </tr>
                      {g.cards.map(renderRow)}
                    </Fragment>
                  ))
                : filtered.map(renderRow)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function dueChip(card: Flashcard): { label: string; tone: 'due' | 'soon' | 'suspended' } {
  if (card.suspended) return { label: 'Suspended', tone: 'suspended' };
  if (new Date(card.dueAt).getTime() <= Date.now()) return { label: 'Due now', tone: 'due' };
  return { label: formatDueIn(card.dueAt), tone: 'soon' };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
