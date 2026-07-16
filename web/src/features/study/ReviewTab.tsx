// Full-screen-ish distraction-light review flow: reveal (Space/click) → grade
// (1-4 keys or click) → auto-advance. Keyboard bindings are only attached
// while this tab is mounted and a card is actively being reviewed.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Flashcard, StudyStats } from '../../lib/types';
import { toast } from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import { nextIntervalHints, type Rating } from './sm2';
import './StudyPage.css';

type Phase = 'loading' | 'empty' | 'active' | 'summary' | 'error';

const RATING_META: Array<{ key: Rating; label: string; keyHint: string; tone: string }> = [
  { key: 'again', label: 'Again', keyHint: '1', tone: 'again' },
  { key: 'hard', label: 'Hard', keyHint: '2', tone: 'hard' },
  { key: 'good', label: 'Good', keyHint: '3', tone: 'good' },
  { key: 'easy', label: 'Easy', keyHint: '4', tone: 'easy' },
];

const KEY_TO_RATING: Record<string, Rating> = {
  Digit1: 'again', Digit2: 'hard', Digit3: 'good', Digit4: 'easy',
  Numpad1: 'again', Numpad2: 'hard', Numpad3: 'good', Numpad4: 'easy',
};

export default function ReviewTab({ stats, notebookId, onReviewed, onSwitchToBrowse }: {
  stats: StudyStats | null;
  /** Scope the queue to one notebook (cram a single module before its exam). */
  notebookId?: string;
  onReviewed: () => void;
  onSwitchToBrowse: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [queue, setQueue] = useState<Flashcard[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);

  const load = useCallback(async () => {
    setPhase('loading');
    setIndex(0);
    setRevealed(false);
    setReviewedCount(0);
    try {
      const res = await api.studyQueue(20, notebookId);
      setQueue(res.cards);
      setPhase(res.cards.length === 0 ? 'empty' : 'active');
    } catch {
      setPhase('error');
    }
  }, [notebookId]);

  useEffect(() => { load(); }, [load]);

  const card = queue[index];

  const handleRate = useCallback(async (rating: Rating) => {
    if (!card || submitting) return;
    setSubmitting(true);
    try {
      await api.review(card.id, rating);
      setReviewedCount(c => c + 1);
      onReviewed();
      const next = index + 1;
      if (next >= queue.length) {
        setPhase('summary');
      } else {
        setIndex(next);
        setRevealed(false);
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that review', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [card, submitting, index, queue.length, onReviewed]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (phase !== 'active') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        return;
      }
      const rating = KEY_TO_RATING[e.code];
      if (rating && revealed) {
        e.preventDefault();
        handleRate(rating);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, revealed, handleRate]);

  if (phase === 'loading') {
    return (
      <div className="sy-review-card sy-review-card--loading">
        <Skeleton lines={4} />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <EmptyState
        icon="⚠️"
        title="Couldn't load your review queue"
        hint="Check the server connection and try again."
        action={<button type="button" className="sy-btn sy-btn--primary" onClick={load}>Retry</button>}
      />
    );
  }

  if (phase === 'empty') {
    return (
      <EmptyState
        icon="🎉"
        title="You're all caught up"
        hint="0 cards due right now — generate flashcards from any note's AI menu to add more."
        action={<button type="button" className="sy-btn" onClick={onSwitchToBrowse}>Browse all cards</button>}
      />
    );
  }

  if (phase === 'summary') {
    return (
      <div className="sy-summary">
        <div className="sy-summary__icon" aria-hidden="true">✨</div>
        <h2>Nice work</h2>
        <p className="sy-summary__count">{reviewedCount} card{reviewedCount === 1 ? '' : 's'} reviewed</p>
        {stats && (
          <p className="sy-summary__streak">
            You've reviewed {stats.reviewedToday} card{stats.reviewedToday === 1 ? '' : 's'} today.
          </p>
        )}
        <div className="sy-summary__actions">
          <button type="button" className="sy-btn sy-btn--primary" onClick={load}>Review again</button>
          <button type="button" className="sy-btn" onClick={onSwitchToBrowse}>Browse cards</button>
        </div>
      </div>
    );
  }

  if (!card) return null;

  const hints = nextIntervalHints(card.reps);
  const progress = queue.length ? (reviewedCount / queue.length) * 100 : 0;

  return (
    <div className="sy-review">
      <div className="sy-review__meta">
        <span className="sy-review__counter">{queue.length - reviewedCount} due</span>
        <div className="sy-review__progress">
          <div className="sy-review__progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className={`sy-review-card${revealed ? ' is-revealed' : ''}`}>
        <div className="sy-review-card__inner">
          <div className="sy-review-card__face sy-review-card__face--front">
            {card.noteId && (
              <Link className="sy-chip" to={`/note/${card.noteId}`}>
                📄 {card.noteTitle ?? 'Untitled note'}
              </Link>
            )}
            <div className="sy-review-card__question">{card.question}</div>
            <button type="button" className="sy-btn sy-btn--primary sy-review-card__reveal" onClick={() => setRevealed(true)}>
              Show answer <span className="sy-key-hint">Space</span>
            </button>
          </div>
          <div className="sy-review-card__face sy-review-card__face--back">
            {card.noteId && (
              <Link className="sy-chip" to={`/note/${card.noteId}`}>
                📄 {card.noteTitle ?? 'Untitled note'}
              </Link>
            )}
            <div className="sy-review-card__question sy-review-card__question--small">{card.question}</div>
            <div className="sy-review-card__divider" />
            <div className="sy-review-card__answer">{card.answer}</div>
          </div>
        </div>
      </div>

      <div className="sy-ratings">
        {RATING_META.map(r => (
          <button
            key={r.key}
            type="button"
            className={`sy-rating-btn sy-rating-btn--${r.tone}`}
            disabled={!revealed || submitting}
            onClick={() => handleRate(r.key)}
          >
            <span className="sy-rating-btn__label">{r.label}</span>
            <span className="sy-rating-btn__hint">{hints[r.key]}</span>
            <span className="sy-key-hint">{r.keyHint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
