// The review screen — where "nothing commits until confirmed" lives. Left rail = the proposed
// categories; main = items grouped under their proposed notebook. Every item can be reassigned,
// re-tagged, retitled, previewed, merged into an existing note, or rejected; proposed NEW
// notebooks must be explicitly approved before their items can be imported.
import { useMemo, useState } from 'react';
import Icon from '../../../components/Icon';
import { api } from '../../../lib/api';
import type { ImportItem, NotebookLite } from '../../../lib/types';
import { confidenceBand } from '../categorise/types';
import { buildGroups, effectiveTags, itemTarget, type TargetRef } from './helpers';

interface ReviewStageProps {
  batchId: string;
  items: ImportItem[];
  setItems: (updater: (cur: ImportItem[]) => ImportItem[]) => void;
  notebooks: NotebookLite[];
  categoriser: string;
  onImport: (itemIds: string[]) => void;
  onCancel: () => void;
}

const NEW_OPTION = '__new__';

export default function ReviewStage({ batchId, items, setItems, notebooks, categoriser, onImport, onCancel }: ReviewStageProps) {
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [sortByConfidence, setSortByConfidence] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [approvedNew, setApprovedNew] = useState<Set<string>>(new Set());
  const [editingNewFor, setEditingNewFor] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const notebooksById = useMemo(() => {
    const m = new Map<string, { name: string; emoji: string }>();
    for (const n of notebooks) m.set(n.id, { name: n.name, emoji: n.emoji });
    return m;
  }, [notebooks]);

  const groups = useMemo(() => buildGroups(items, notebooksById), [items, notebooksById]);

  const isUnsorted = (t: TargetRef) => t.kind === 'new' && t.name.toLowerCase() === 'unsorted';
  const newApproved = (t: TargetRef) => t.kind === 'existing' || isUnsorted(t) || approvedNew.has(t.name.toLowerCase());

  // An item is importable when it is not rejected and its target is committable.
  const importableIds = useMemo(() => {
    const ids: string[] = [];
    for (const it of items) {
      if (it.status === 'rejected' || it.status === 'committed') continue;
      if (newApproved(itemTarget(it, notebooksById))) ids.push(it.id);
    }
    return ids;
  }, [items, notebooksById, approvedNew]);

  const pendingNewNotebooks = useMemo(() => {
    const names = new Set<string>();
    for (const g of groups) if (g.target.kind === 'new' && !isUnsorted(g.target) && !approvedNew.has(g.target.name.toLowerCase())) names.add(g.target.name);
    return names;
  }, [groups, approvedNew]);

  async function patch(itemId: string, body: Parameters<typeof api.decideImportItem>[2]) {
    setError(null);
    try {
      const { item } = await api.decideImportItem(batchId, itemId, body);
      setItems((cur) => cur.map((i) => (i.id === item.id ? item : i)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that change');
    }
  }

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleExpand(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const visibleItems = useMemo(() => {
    let list = activeGroup ? (groups.find((g) => g.key === activeGroup)?.items ?? []) : items;
    if (sortByConfidence) list = [...list].sort((a, b) => a.confidence - b.confidence);
    return list;
  }, [activeGroup, groups, items, sortByConfidence]);

  async function bulk(action: 'accept' | 'reject' | 'move', notebookId?: string) {
    const ids = [...selected];
    if (!ids.length) return;
    for (const id of ids) {
      if (action === 'accept') await patch(id, { status: 'accepted' });
      else if (action === 'reject') await patch(id, { status: 'rejected' });
      else if (action === 'move' && notebookId) await patch(id, { decidedNotebookId: notebookId });
    }
    setSelected(new Set());
  }

  function selectLowConfidence() {
    setSelected(new Set(items.filter((it) => confidenceBand(it.confidence) === 'low' && it.status !== 'rejected').map((it) => it.id)));
  }

  async function renameNewGroup(oldName: string, nextName: string) {
    const trimmed = nextName.trim();
    setRenamingGroup(null);
    if (!trimmed || trimmed.toLowerCase() === oldName.toLowerCase()) return;
    const affected = items.filter((it) => itemTarget(it, notebooksById).kind === 'new' && (it.decidedNotebookName ?? it.suggestedNotebookName ?? '').toLowerCase() === oldName.toLowerCase());
    for (const it of affected) await patch(it.id, { decidedNotebookName: trimmed });
    setApprovedNew((cur) => {
      const next = new Set(cur);
      if (next.delete(oldName.toLowerCase())) next.add(trimmed.toLowerCase());
      return next;
    });
  }

  const acceptedCount = importableIds.length;

  return (
    <div className="iw-review">
      <div className="iw-review-banner" role="status">
        <Icon name={categoriser === 'heuristic' ? 'folder-plus' : 'sparkles'} size={15} />
        <span>
          {categoriser === 'heuristic'
            ? 'Sorted by folder, filename and keywords. AI is offline, so review and adjust below.'
            : 'Sorted with AI. Review the suggestions below.'}
        </span>
      </div>

      <div className="iw-review-body">
        {/* Left rail: proposed categories + bulk actions */}
        <aside className="iw-rail" aria-label="Proposed notebooks">
          <button type="button" className={`iw-rail-item ${activeGroup === null ? 'is-active' : ''}`} onClick={() => setActiveGroup(null)}>
            <span className="iw-rail-name">All notes</span>
            <span className="iw-rail-count">{items.length}</span>
          </button>
          <div className="iw-rail-scroll">
            {groups.map((g) => {
              const proposedNew = g.target.kind === 'new' && !isUnsorted(g.target);
              const approved = newApproved(g.target);
              return (
                <div key={g.key} className={`iw-rail-row ${activeGroup === g.key ? 'is-active' : ''}`}>
                  <button type="button" className="iw-rail-item" onClick={() => setActiveGroup(g.key)}>
                    {renamingGroup === g.key ? (
                      <input
                        className="iw-inline-input"
                        autoFocus
                        defaultValue={g.target.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => renameNewGroup(g.target.name, e.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') renameNewGroup(g.target.name, e.currentTarget.value); if (e.key === 'Escape') setRenamingGroup(null); }}
                      />
                    ) : (
                      <span className="iw-rail-name">
                        {g.target.kind === 'existing' && notebooksById.get(g.target.id!)?.emoji} {g.target.name}
                      </span>
                    )}
                    {proposedNew && <span className={`iw-badge ${approved ? 'is-ok' : ''}`}>{approved ? 'NEW' : 'NEW?'}</span>}
                    <span className="iw-rail-count">{g.items.length}</span>
                  </button>
                  {proposedNew && (
                    <div className="iw-rail-actions">
                      <label className="iw-approve">
                        <input
                          type="checkbox"
                          checked={approved}
                          onChange={(e) => setApprovedNew((cur) => { const n = new Set(cur); if (e.target.checked) n.add(g.target.name.toLowerCase()); else n.delete(g.target.name.toLowerCase()); return n; })}
                        />
                        Approve
                      </label>
                      <button type="button" className="iw-linkbtn" onClick={() => setRenamingGroup(g.key)}>Rename</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="iw-bulk">
            <div className="iw-bulk-title">{selected.size} selected</div>
            <button type="button" className="iw-btn iw-btn-ghost" onClick={() => bulk('accept')} disabled={!selected.size}>Accept</button>
            <button type="button" className="iw-btn iw-btn-ghost" onClick={() => bulk('reject')} disabled={!selected.size}>Reject</button>
            <label className="iw-move">
              Move to
              <select
                disabled={!selected.size}
                value=""
                onChange={(e) => { if (e.target.value) bulk('move', e.target.value); e.currentTarget.selectedIndex = 0; }}
              >
                <option value="">notebook…</option>
                {notebooks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
              </select>
            </label>
            <button type="button" className="iw-linkbtn" onClick={selectLowConfidence}>Select all low confidence</button>
          </div>
        </aside>

        {/* Main: items */}
        <div className="iw-items">
          <div className="iw-items-head">
            <span>{activeGroup ? groups.find((g) => g.key === activeGroup)?.target.name : 'All notes'} · {visibleItems.length}</span>
            <label className="iw-sort">
              <input type="checkbox" checked={sortByConfidence} onChange={(e) => setSortByConfidence(e.target.checked)} />
              Least confident first
            </label>
          </div>

          <ul className="iw-list">
            {visibleItems.map((it) => {
              const target = itemTarget(it, notebooksById);
              const rejected = it.status === 'rejected';
              const band = confidenceBand(it.confidence);
              const tags = effectiveTags(it);
              const selectVal = it.decidedNotebookId ?? it.suggestedNotebookId ?? (target.kind === 'new' ? `new:${target.name}` : '');
              return (
                <li key={it.id} className={`iw-item ${rejected ? 'is-rejected' : ''}`}>
                  <input className="iw-item-check" type="checkbox" aria-label="Select" checked={selected.has(it.id)} onChange={() => toggleSelect(it.id)} />

                  {it.kind === 'photo' && it.imageUrl ? (
                    <img className="iw-thumb" src={it.imageUrl} alt="" />
                  ) : (
                    <span className={`iw-conf iw-conf-${band}`} title={it.rationale ?? ''} aria-label={`${band} confidence`} />
                  )}

                  <div className="iw-item-main">
                    <input
                      className="iw-title-input"
                      defaultValue={it.title}
                      aria-label="Note title"
                      onBlur={(e) => { if (e.target.value !== it.title) patch(it.id, { title: e.target.value }); }}
                    />
                    <div className="iw-item-meta">
                      <span className="iw-src" title={it.sourcePath ?? it.originalName}>{it.sourcePath ?? it.originalName}</span>
                      <span aria-hidden>·</span>
                      <span>{it.kind === 'photo' ? 'photo' : `${it.wordCount} words`}</span>
                      {it.rationale && <span className="iw-why">· {it.rationale}</span>}
                      {it.error && <span className="iw-err">· {it.error}</span>}
                    </div>

                    <div className="iw-controls">
                      <label className="iw-field">
                        <span className="iw-field-label">Notebook</span>
                        {editingNewFor === it.id ? (
                          <input
                            className="iw-inline-input"
                            autoFocus
                            placeholder="New notebook name"
                            defaultValue={target.kind === 'new' ? target.name : ''}
                            onBlur={(e) => { setEditingNewFor(null); if (e.target.value.trim()) patch(it.id, { decidedNotebookName: e.target.value.trim() }); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { setEditingNewFor(null); const v = e.currentTarget.value.trim(); if (v) patch(it.id, { decidedNotebookName: v }); } if (e.key === 'Escape') setEditingNewFor(null); }}
                          />
                        ) : (
                          <select
                            className="iw-select"
                            value={selectVal}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === NEW_OPTION) { setEditingNewFor(it.id); return; }
                              if (v.startsWith('new:')) return;
                              patch(it.id, { decidedNotebookId: v });
                            }}
                          >
                            {target.kind === 'new' && <option value={`new:${target.name}`}>✦ New: {target.name}</option>}
                            {notebooks.map((n) => <option key={n.id} value={n.id}>{n.emoji} {n.name}</option>)}
                            <option value={NEW_OPTION}>＋ New notebook…</option>
                          </select>
                        )}
                      </label>

                      <div className="iw-field iw-tags">
                        <span className="iw-field-label">Tags</span>
                        <div className="iw-chips">
                          {tags.map((t) => (
                            <span key={t} className="iw-chip">
                              #{t}
                              <button type="button" aria-label={`Remove ${t}`} onClick={() => patch(it.id, { decidedTags: tags.filter((x) => x !== t) })}>
                                <Icon name="x" size={11} />
                              </button>
                            </span>
                          ))}
                          <input
                            className="iw-chip-input"
                            placeholder="add tag"
                            aria-label="Add tag"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                                patch(it.id, { decidedTags: [...tags, e.currentTarget.value.trim()] });
                                e.currentTarget.value = '';
                              }
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {expanded.has(it.id) && (
                      <div className="iw-preview">
                        {it.kind === 'photo' && it.imageUrl && <img src={it.imageUrl} alt={it.originalName} />}
                        <pre>{it.preview || '(no text extracted)'}</pre>
                      </div>
                    )}
                  </div>

                  <div className="iw-item-side">
                    <button type="button" className="iw-icon-btn" aria-pressed={expanded.has(it.id)} title="Preview" onClick={() => toggleExpand(it.id)}>
                      <Icon name="file-text" size={15} />
                    </button>
                    <button
                      type="button"
                      className={`iw-icon-btn ${rejected ? 'is-danger' : ''}`}
                      title={rejected ? 'Restore' : 'Reject'}
                      onClick={() => patch(it.id, { status: rejected ? 'accepted' : 'rejected' })}
                    >
                      <Icon name={rejected ? 'rotate-ccw' : 'trash'} size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="iw-footer">
        <button type="button" className="iw-btn iw-btn-ghost" onClick={onCancel}>Cancel</button>
        <div className="iw-footer-status">
          {error && <span className="iw-err">{error}</span>}
          {pendingNewNotebooks.size > 0 && (
            <span className="iw-warn">Approve {pendingNewNotebooks.size} new notebook{pendingNewNotebooks.size > 1 ? 's' : ''} to include {pendingNewNotebooks.size > 1 ? 'them' : 'it'}.</span>
          )}
          <span className="iw-count">{acceptedCount} of {items.length} ready</span>
        </div>
        <button type="button" className="iw-btn iw-btn-primary" disabled={!acceptedCount} onClick={() => onImport(importableIds)}>
          Import {acceptedCount} note{acceptedCount === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}
