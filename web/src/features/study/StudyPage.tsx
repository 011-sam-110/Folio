import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { StudyStats } from '../../lib/types';
import { toast } from '../../components/Toast';
import { useNotebooks } from '../../components/NotebooksContext';
import ReviewTab from './ReviewTab';
import BrowseTab from './BrowseTab';
import './StudyPage.css';

type Tab = 'review' | 'browse';

export default function StudyPage() {
  const [tab, setTab] = useState<Tab>('review');
  const [stats, setStats] = useState<StudyStats | null>(null);
  // Cram-one-module filter: scopes the review queue to a single notebook (fix 24).
  const [notebookFilter, setNotebookFilter] = useState<string | undefined>(undefined);
  const { notebooks } = useNotebooks();
  const visibleNotebooks = notebooks.filter((n) => !n.archived);
  const filterName = notebookFilter ? visibleNotebooks.find((n) => n.id === notebookFilter)?.name : undefined;

  const refreshStats = useCallback(async () => {
    try {
      const res = await api.studyStats();
      setStats(res);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load study stats', 'error');
    }
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  return (
    <div className="sy-page">
      <header className="sy-page__header">
        <div>
          <h1>Study</h1>
          <p className="sy-page__sub">
            {filterName ? `Reviewing ${filterName} only` : 'Spaced repetition across every notebook'}
          </p>
        </div>
        <div className="sy-tabs" role="tablist" aria-label="Study view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'review'}
            className={`sy-tab${tab === 'review' ? ' is-active' : ''}`}
            onClick={() => setTab('review')}
          >
            Review{stats && stats.due > 0 ? ` · ${stats.due} due` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'browse'}
            className={`sy-tab${tab === 'browse' ? ' is-active' : ''}`}
            onClick={() => setTab('browse')}
          >
            Browse{stats ? ` · ${stats.total}` : ''}
          </button>
        </div>
      </header>

      {tab === 'review' && visibleNotebooks.length > 1 && (
        <div className="sy-filter" role="group" aria-label="Filter review queue by notebook" data-testid="study-notebook-filter">
          <button
            type="button"
            className={`sy-filter-chip${!notebookFilter ? ' is-active' : ''}`}
            onClick={() => setNotebookFilter(undefined)}
          >
            All notebooks
          </button>
          {visibleNotebooks.map((nb) => (
            <button
              key={nb.id}
              type="button"
              className={`sy-filter-chip${notebookFilter === nb.id ? ' is-active' : ''}`}
              onClick={() => setNotebookFilter((cur) => (cur === nb.id ? undefined : nb.id))}
            >
              {nb.emoji} {nb.name}
            </button>
          ))}
        </div>
      )}

      {tab === 'review' ? (
        <ReviewTab
          key={notebookFilter ?? 'all'}
          stats={stats}
          notebookId={notebookFilter}
          onReviewed={refreshStats}
          onSwitchToBrowse={() => setTab('browse')}
        />
      ) : (
        <BrowseTab stats={stats} onChanged={refreshStats} />
      )}
    </div>
  );
}
