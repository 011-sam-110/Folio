// Inline "New card" composer row for the Browse tab (iteration 2 manual flashcards).
// Deliberately inline rather than a modal - creating a few cards back-to-back shouldn't
// require re-opening a dialog each time (submit keeps the row open and clears the fields).
import { useState, type KeyboardEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import type { Flashcard, TitleResult } from '../../lib/types';
import { toast } from '../../components/Toast';
import NoteLinkPicker from './NoteLinkPicker';
import './StudyPage.css';

export default function CardComposer({
  onCreated,
  onCancel,
}: {
  onCreated: (card: Flashcard) => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState<TitleResult | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!question.trim() || !answer.trim()) {
      toast("Question and answer can't be empty", 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await api.createCard({ noteId: note?.id, question: question.trim(), answer: answer.trim() });
      toast('Card added', 'ok');
      onCreated(res.card);
      setQuestion('');
      setAnswer('');
      setNote(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create card', 'error');
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  }

  return (
    <div className="sy-composer" role="group" aria-label="New flashcard" onKeyDown={onKeyDown}>
      <div className="sy-composer__fields">
        <textarea
          className="sy-composer__field"
          aria-label="Question"
          placeholder="Question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          autoFocus
        />
        <textarea
          className="sy-composer__field"
          aria-label="Answer"
          placeholder="Answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={2}
        />
        <NoteLinkPicker value={note} onChange={setNote} />
      </div>
      <div className="sy-composer__actions">
        <button type="button" className="sy-btn sy-btn--primary" disabled={saving} onClick={submit}>
          {saving ? 'Adding…' : 'Add card'}
        </button>
        <button type="button" className="sy-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <span className="sy-composer__hint">
          <span className="sy-key-hint">⌘</span>
          <span className="sy-key-hint">↵</span> to add
        </span>
      </div>
    </div>
  );
}
