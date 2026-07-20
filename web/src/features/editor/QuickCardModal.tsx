// "Add to flashcards" quick composer, opened from SelectionToolbar. The selected text
// pre-fills the answer; the student only has to type the question. Saves via
// api.createCard (the manual-flashcard endpoint — server route is study-manual's) and
// links straight to /study on success.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../../components/Modal';
import Spinner from '../../components/Spinner';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import './notePage.css';

export interface QuickCardModalProps {
  open: boolean;
  onClose: () => void;
  noteId?: string;
  initialAnswer: string;
}

export default function QuickCardModal({ open, onClose, noteId, initialAnswer }: QuickCardModalProps) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(initialAnswer);
  const [saving, setSaving] = useState(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setQuestion('');
    setAnswer(initialAnswer);
    // Modal.tsx's own focus trap grabs the first focusable element on open; defer one tick
    // so the question field (not the modal panel) ends up with focus, per spec.
    const t = window.setTimeout(() => questionRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, initialAnswer]);

  async function save() {
    const q = question.trim();
    const a = answer.trim();
    if (!q || !a || saving) return;
    setSaving(true);
    try {
      await api.createCard({ noteId, question: q, answer: a });
      onClose();
      toast('Card added to your deck', 'ok', {
        action: { label: 'Study', onClick: () => navigate('/study') },
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the card', 'error');
    } finally {
      setSaving(false);
    }
  }

  const canSave = !!question.trim() && !!answer.trim() && !saving;

  return (
    <Modal open={open} onClose={onClose} title="Add to flashcards" width={440}>
      <div className="folio-quickcard">
        <label className="folio-field">
          <span>Question</span>
          <textarea
            ref={questionRef}
            className="folio-field-input"
            rows={2}
            value={question}
            placeholder="What should this card ask?"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
        </label>
        <label className="folio-field">
          <span>Answer</span>
          <textarea
            className="folio-field-input"
            rows={4}
            value={answer}
            placeholder="Answer"
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
        </label>
        <div className="folio-quickcard-actions">
          <button type="button" className="folio-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="folio-btn-primary" onClick={save} disabled={!canSave}>
            {saving ? <Spinner size={14} /> : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
