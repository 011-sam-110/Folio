import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { DashboardData, Notebook } from '../lib/types';
import { errorMessage, greeting, longDate, numberFmt, plural, relativeTime } from '../lib/format';
import NoteCard from '../components/NoteCard';
import EmptyState from '../components/EmptyState';
import Skeleton from '../components/Skeleton';
import Spinner from '../components/Spinner';
import Icon from '../components/Icon';
import EmojiPicker from '../components/EmojiPicker';
import { useNotebooks } from '../components/NotebooksContext';
import { toast } from '../components/Toast';

const SUGGESTED_NOTEBOOKS = [
  { name: 'Algorithms & Data Structures', emoji: '📗' },
  { name: 'Databases', emoji: '🗄️' },
  { name: 'Operating Systems', emoji: '⚙️' },
  { name: 'Software Engineering', emoji: '🧩' },
  { name: 'Personal', emoji: '✨' },
];

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .dashboard()
      .then(setData)
      .catch((e) => setError(errorMessage(e, 'Could not load your dashboard')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="dash">
        <div className="dash__main">
          <div style={{ maxWidth: 260 }}>
            <Skeleton lines={2} />
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
            <Skeleton lines={4} />
          </div>
          <div className="note-grid">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: 14 }}>
                <Skeleton lines={3} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dash">
        <EmptyState
          icon="⚠️"
          title="Couldn't load your dashboard"
          hint={error}
          action={
            <button type="button" className="btn btn-primary" onClick={load}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (!data) return null;

  if (data.stats.notebooks === 0) {
    return (
      <div className="dash">
        <div className="dash__onboard" style={{ margin: '8vh auto', maxWidth: 480 }}>
          <OnboardingCreateNotebook onCreated={(nb) => navigate(`/notebook/${nb.id}`)} />
        </div>
      </div>
    );
  }

  return (
    <div className="dash">
      <div className="dash__main">
        <header className="dash__header">
          <h1 className="dash__greeting">{greeting()}</h1>
          <div className="dash__date">{longDate()}</div>
        </header>

        {data.continueNote && (
          <Link to={`/note/${data.continueNote.id}`} className="dash__hero" data-testid="continue-card">
            <div className="dash__hero-label">Continue where you left off</div>
            <div className="dash__hero-title">{data.continueNote.title || 'Untitled'}</div>
            {data.continueNote.snippet && <div className="dash__hero-snippet">{data.continueNote.snippet}</div>}
            <div className="dash__hero-meta">
              <span>
                {data.continueNote.notebook.emoji} {data.continueNote.notebook.name}
              </span>
              <span>·</span>
              <span>{relativeTime(data.continueNote.updatedAt)}</span>
            </div>
          </Link>
        )}

        <section className="dash__section">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Recent lessons</h2>
          </div>
          {data.recent.length === 0 ? (
            <EmptyState
              icon="📝"
              title="No notes yet"
              hint="Create a note from a notebook in the sidebar, or import a photo of your lecture notes."
            />
          ) : (
            <div className="note-grid" data-testid="recent-notes">
              {data.recent.map((n) => (
                <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
              ))}
            </div>
          )}
        </section>

        {data.pinned.length > 0 && (
          <section className="dash__section">
            <div className="dash__section-head">
              <h2 className="dash__section-title">Pinned</h2>
            </div>
            <div className="note-strip" data-testid="pinned-strip">
              {data.pinned.map((n) => (
                <NoteCard key={n.id} note={n} onClick={() => navigate(`/note/${n.id}`)} />
              ))}
            </div>
          </section>
        )}

        <section className="dash__section">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Notebooks</h2>
          </div>
          <div className="notebook-col-row">
            {data.notebooks.map((nb) => (
              <Link key={nb.id} to={`/notebook/${nb.id}`} className="notebook-col">
                <div className="notebook-col__emoji" aria-hidden="true">{nb.emoji}</div>
                <div className="notebook-col__name">{nb.name}</div>
                <div className="notebook-col__meta">
                  {plural(nb.noteCount, 'note')}
                  {nb.lastNoteAt ? ` · ${relativeTime(nb.lastNoteAt)}` : ''}
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <aside className="dash__rail">
        <div className="rail-card">
          <div className="rail-card__title">Study</div>
          {data.stats.flashcardsDue > 0 ? (
            <>
              <div className="rail-card__due">{data.stats.flashcardsDue}</div>
              <div className="rail-card__due-label">{plural(data.stats.flashcardsDue, 'card')} due</div>
              <Link to="/study" className="btn btn-primary" style={{ width: '100%' }}>
                Start review
              </Link>
            </>
          ) : (
            <>
              <div className="rail-card__celebrate">You're all caught up — 0 due 🎉</div>
              <Link to="/study" className="btn btn-secondary" style={{ width: '100%' }}>
                Browse cards
              </Link>
            </>
          )}
        </div>

        <div className="rail-card">
          <div className="rail-card__title">Last 14 days</div>
          <Heatmap data={data.weekActivity} />
        </div>

        <div className="rail-card">
          <div className="rail-card__title">Stats</div>
          <div className="rail-stats" data-testid="dashboard-stats">
            {plural(data.stats.notes, 'note')} · {numberFmt(data.stats.words)} words
            <br />
            {plural(data.stats.notebooks, 'notebook')}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Heatmap({ data }: { data: DashboardData['weekActivity'] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div>
      <div className="heatmap">
        {data.map((d) => {
          const intensity = d.count === 0 ? 0 : 0.25 + 0.75 * (d.count / max);
          return (
            <div
              key={d.date}
              className="heatmap__cell"
              title={`${plural(d.count, 'edit')} on ${d.date}`}
              style={d.count > 0 ? { backgroundColor: 'var(--accent)', opacity: intensity } : undefined}
            />
          );
        })}
      </div>
      <div className="heatmap__legend">
        <span>{data.length} days</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function OnboardingCreateNotebook({ onCreated }: { onCreated: (nb: Notebook) => void }) {
  const { createNotebook } = useNotebooks();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('📓');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const nb = await createNotebook({ name: trimmed, emoji });
      toast('Notebook created', 'ok');
      onCreated(nb);
    } catch (e2) {
      toast(errorMessage(e2, 'Could not create notebook'), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <EmptyState
      icon="📓"
      title="Add your first notebook"
      hint="One notebook per course or module — Folio's only real piece of structure. Add as many as you like, any time."
      action={
        <form className="notebook-create-form" onSubmit={submit}>
          <div className="notebook-create-form__row">
            <EmojiPicker value={emoji} onSelect={setEmoji} size={18} label="Notebook emoji" />
            <input
              className="text-input"
              placeholder="e.g. Algorithms & Data Structures"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="notebook-suggest-chips">
            {SUGGESTED_NOTEBOOKS.map((s) => (
              <button
                key={s.name}
                type="button"
                className="chip"
                onClick={() => {
                  setName(s.name);
                  setEmoji(s.emoji);
                }}
              >
                {s.emoji} {s.name}
              </button>
            ))}
          </div>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || submitting}>
            {submitting ? <Spinner size={13} /> : <Icon name="plus" size={14} />}
            Create notebook
          </button>
        </form>
      }
    />
  );
}
