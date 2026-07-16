import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { StudyStats } from '../../lib/types';
import { toast } from '../../components/Toast';
import ReviewTab from './ReviewTab';
import BrowseTab from './BrowseTab';
import './StudyPage.css';

type Tab = 'review' | 'browse';

export default function StudyPage() {
  const [tab, setTab] = useState<Tab>('review');
  const [stats, setStats] = useState<StudyStats | null>(null);

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
          <p className="sy-page__sub">Spaced repetition across every notebook</p>
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

      {tab === 'review' ? (
        <ReviewTab stats={stats} onReviewed={refreshStats} onSwitchToBrowse={() => setTab('browse')} />
      ) : (
        <BrowseTab stats={stats} onChanged={refreshStats} />
      )}
    </div>
  );
}
