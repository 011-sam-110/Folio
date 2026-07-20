// search-tags agent — tag browser: a sized pill grid of every tag in use,
// multi-select filtering (intersection) of an inline note list, and a
// "search notes →" escape hatch into the full search page's tag: operator.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { NoteLite } from '../lib/types';
import { errorMessage, plural } from '../lib/format';
import NoteCard from '../components/NoteCard';
import EmptyState from '../components/EmptyState';
import Skeleton from '../components/Skeleton';
import Icon from '../components/Icon';
import './TagsPage.css';

interface TagCount {
  tag: string;
  count: number;
}

export default function TagsPage() {
  const navigate = useNavigate();

  const [tags, setTags] = useState<TagCount[] | null>(null);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [notes, setNotes] = useState<NoteLite[] | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  const loadTags = useCallback(() => {
    setTagsLoading(true);
    setTagsError(null);
    api
      .tags()
      .then((res) => setTags(res.tags))
      .catch((e) => setTagsError(errorMessage(e, 'Could not load tags')))
      .finally(() => setTagsLoading(false));
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  // Multi-select = intersection: fetch by the first selected tag (server-side
  // filter, cheap), then narrow further client-side for any additional tags —
  // a note must carry ALL selected tags to stay in the list.
  useEffect(() => {
    if (selected.length === 0) {
      setNotes(null);
      setNotesError(null);
      return;
    }
    const [first, ...rest] = selected;
    setNotesLoading(true);
    setNotesError(null);
    api
      .notes({ tag: first, limit: 200, sort: 'updated' })
      .then((res) => {
        const filtered = rest.length ? res.notes.filter((n) => rest.every((t) => n.tags.includes(t))) : res.notes;
        setNotes(filtered);
      })
      .catch((e) => setNotesError(errorMessage(e, 'Could not load notes')))
      .finally(() => setNotesLoading(false));
  }, [selected]);

  function toggleTag(tag: string) {
    setSelected((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  const { minCount, maxCount } = useMemo(() => {
    if (!tags || tags.length === 0) return { minCount: 0, maxCount: 0 };
    const counts = tags.map((t) => t.count);
    return { minCount: Math.min(...counts), maxCount: Math.max(...counts) };
  }, [tags]);

  function sizeFor(count: number): number {
    if (maxCount === minCount) return 14;
    const t = (count - minCount) / (maxCount - minCount);
    return 13 + t * 6; // 13px .. 19px — a gentle "cloud" without a handful of tags towering over the rest
  }

  return (
    <div className="tg-page">
      <div className="tg-page__crumb">Tags</div>
      <div className="tg-page__header">
        <h1 className="tg-page__title">Browse by tag</h1>
        {tags && tags.length > 0 && <div className="tg-page__count">{plural(tags.length, 'tag')} across your notes</div>}
      </div>

      {tagsLoading ? (
        <div className="tg-cloud">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="tg-row tg-row--skeleton" style={{ width: 120 + (i % 4) * 30 }}>
              <Skeleton lines={1} />
            </div>
          ))}
        </div>
      ) : tagsError ? (
        <EmptyState
          icon="⚠️"
          title="Couldn't load tags"
          hint={tagsError}
          action={
            <button type="button" className="btn btn-primary" onClick={loadTags}>
              Retry
            </button>
          }
        />
      ) : !tags || tags.length === 0 ? (
        <EmptyState
          icon="🏷️"
          title="No tags yet"
          hint='Add a #tag to a note (or use the tags field on a note) and it will show up here as a filterable pill.'
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
              Go to your notes
            </button>
          }
        />
      ) : (
        <>
          <div className="tg-cloud" role="group" aria-label="Filter by tag">
            {tags.map(({ tag, count }) => {
              const active = selected.includes(tag);
              return (
                <div className={`tg-row${active ? ' is-active' : ''}`} key={tag}>
                  <button
                    type="button"
                    className="tg-row__toggle"
                    aria-pressed={active}
                    onClick={() => toggleTag(tag)}
                  >
                    <span className="tg-row__name" style={{ fontSize: sizeFor(count) }}>
                      #{tag}
                    </span>
                    <span className="tg-row__count">{count}</span>
                  </button>
                  <Link
                    className="tg-row__search-link"
                    to={`/search?q=${encodeURIComponent(`tag:${tag}`)}`}
                    aria-label={`Search notes tagged ${tag}`}
                    title="Search notes →"
                  >
                    <Icon name="search" size={12} />
                  </Link>
                </div>
              );
            })}
          </div>

          {selected.length > 0 && (
            <div className="tg-active-filters">
              <span>Showing notes tagged</span>
              {selected.map((t) => (
                <button key={t} type="button" className="chip active" onClick={() => toggleTag(t)}>
                  #{t} <Icon name="x" size={11} />
                </button>
              ))}
              <button type="button" className="tg-clear" onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
          )}

          <div className="tg-results">
            {selected.length === 0 ? (
              <EmptyState
                icon="👆"
                title="Pick a tag to see its notes"
                hint="Select one or more pills above — with more than one, only notes carrying every selected tag are shown."
              />
            ) : notesLoading ? (
              <div className="note-list">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
                    <Skeleton lines={2} />
                  </div>
                ))}
              </div>
            ) : notesError ? (
              <EmptyState
                icon="⚠️"
                title="Couldn't load notes"
                hint={notesError}
                action={
                  <button type="button" className="btn btn-primary" onClick={() => setSelected((s) => [...s])}>
                    Retry
                  </button>
                }
              />
            ) : !notes || notes.length === 0 ? (
              <EmptyState
                icon="🔎"
                title="No notes have all of these tags"
                hint="Try removing one of the selected tags."
                action={
                  selected.length > 1 ? (
                    <button type="button" className="btn btn-secondary" onClick={() => setSelected([selected[0]])}>
                      Keep only #{selected[0]}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-secondary" onClick={() => setSelected([])}>
                      Clear filter
                    </button>
                  )
                }
              />
            ) : (
              <div className="note-list">
                {notes.map((n) => (
                  <NoteCard key={n.id} note={n} compact testId="note-row" onClick={() => navigate(`/note/${n.id}`)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
