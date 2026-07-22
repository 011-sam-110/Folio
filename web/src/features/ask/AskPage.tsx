import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, ApiError } from '../../lib/api';
import type { Notebook } from '../../lib/types';
import { toast } from '../../components/Toast';
import EmptyState from '../../components/EmptyState';
import { useAiEnabled } from '../../lib/aiPrefs';
import { refreshAiHealth, useAiHealth } from '../../lib/aiStatus';
import { markdownToDoc } from './mdToTiptap';
import './AskPage.css';

interface Source { id: string; title: string }

interface Pair {
  id: string;
  question: string;
  notebookId: string | null;
  status: 'loading' | 'done' | 'error';
  answer?: string;
  sources?: Source[];
  model?: string;
  error?: string;
}

export default function AskPage() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookFilter, setNotebookFilter] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [asking, setAsking] = useState(false);
  const [insertingId, setInsertingId] = useState<string | null>(null);
  const [aiOn, setAiOn] = useAiEnabled();
  // Must be called here, above the early returns below — a hook after a conditional
  // return would break the rules-of-hooks ordering.
  const aiHealth = useAiHealth();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.notebooks().then(res => setNotebooks(res.notebooks)).catch(() => { /* filter chips just won't show */ });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [pairs.length]);

  // The AI kill-switch removes this whole surface — show a plain explanation instead of
  // a broken page for anyone who lands here via URL/bookmark. (After all hooks.)
  if (!aiOn) {
    return (
      <div className="ask-page" data-testid="ask-disabled">
        <EmptyState
          icon="📓"
          title="AI features are turned off"
          hint="You switched Unote to plain-notebook mode. Turn AI back on any time. Nothing about your notes changes either way."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setAiOn(true)}>
              Turn AI back on
            </button>
          }
        />
      </div>
    );
  }

  // Distinct from the kill-switch above on purpose: "you turned this off" and "the
  // model gateway can't be reached" are different problems with different fixes, and
  // collapsing them into one message sends the user looking in the wrong place.
  if (aiHealth.status === 'bad') {
    return (
      <div className="ask-page" data-testid="ask-unavailable">
        <EmptyState
          icon="🔌"
          title="AI isn’t reachable right now"
          hint={
            aiHealth.error
              ? `Unote couldn’t reach the model gateway (${aiHealth.error}). Everything else works as normal: notes, search, flashcards, canvas.`
              : 'Unote couldn’t reach the model gateway. Everything else works as normal: notes, search, flashcards, canvas.'
          }
          action={
            <button type="button" className="btn" onClick={() => void refreshAiHealth()}>
              Try again
            </button>
          }
        />
      </div>
    );
  }

  async function ask() {
    const q = question.trim();
    if (!q || asking) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const notebookId = notebookFilter;
    setPairs(prev => [...prev, { id, question: q, notebookId, status: 'loading' }]);
    setQuestion('');
    setAsking(true);
    try {
      const res = await api.aiAsk(q, notebookId ?? undefined);
      setPairs(prev => prev.map(p => (p.id === id ? { ...p, status: 'done', answer: res.answer, sources: res.sources, model: res.model } : p)));
    } catch (err) {
      const message = err instanceof ApiError
        ? (err.status === 502 ? 'AI offline. Is the gateway running?' : err.message)
        : 'Something went wrong asking your notes.';
      setPairs(prev => prev.map(p => (p.id === id ? { ...p, status: 'error', error: message } : p)));
    } finally {
      setAsking(false);
      textareaRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  }

  async function insertIntoNote(pair: Pair) {
    if (!pair.answer) return;
    const notebookId = pair.notebookId ?? notebooks[0]?.id;
    if (!notebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    setInsertingId(pair.id);
    try {
      const doc = markdownToDoc(pair.answer);
      const res = await api.createNote({
        notebookId,
        title: pair.question.slice(0, 80),
        contentJson: doc,
        contentText: pair.answer,
      });
      toast('Added to a new note', 'ok');
      navigate(`/note/${res.note.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create the note', 'error');
    } finally {
      setInsertingId(null);
    }
  }

  function retry(pair: Pair) {
    setQuestion(pair.question);
    textareaRef.current?.focus();
  }

  return (
    <div className="ak-page">
      <div className="ak-hero">
        <h1>Ask your notes</h1>
        <p className="ak-hero__sub">Answers are generated only from what you've written, with sources.</p>

        <div className="ak-chips">
          <button type="button" className={`ak-chip${notebookFilter === null ? ' is-active' : ''}`} onClick={() => setNotebookFilter(null)}>
            All notebooks
          </button>
          {notebooks.map(nb => (
            <button
              key={nb.id}
              type="button"
              className={`ak-chip${notebookFilter === nb.id ? ' is-active' : ''}`}
              onClick={() => setNotebookFilter(nb.id)}
            >
              {nb.emoji} {nb.name}
            </button>
          ))}
        </div>

        <div className="ak-input">
          <textarea
            ref={textareaRef}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask your notes…"
            rows={2}
            aria-label="Ask your notes"
          />
          <button type="button" className="ak-btn ak-btn--primary ak-input__submit" onClick={ask} disabled={asking || !question.trim()}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </div>

      {pairs.length === 0 ? (
        <EmptyState
          icon="💬"
          title="Nothing asked yet"
          hint="Try something like “What's the difference between a B-tree and a B+ tree?”"
        />
      ) : (
        <div className="ak-thread">
          {pairs.map(pair => (
            <div className="ak-pair" key={pair.id}>
              <div className="ak-bubble--question">{pair.question}</div>

              {pair.status === 'loading' && (
                <div className="ak-answer ak-answer--loading">
                  <div className="ak-shimmer-line" />
                  <div className="ak-shimmer-line" />
                  <div className="ak-shimmer-line ak-shimmer-line--short" />
                </div>
              )}

              {pair.status === 'error' && (
                <div className="ak-answer ak-answer--error">
                  <div className="ak-answer__error-text">{pair.error}</div>
                  <button type="button" className="ak-btn" onClick={() => retry(pair)}>Try again</button>
                </div>
              )}

              {pair.status === 'done' && (
                <div className="ak-answer">
                  <div className="ak-answer__markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(pair.answer ?? '') }} />
                  {pair.sources && pair.sources.length > 0 && (
                    <div className="ak-sources">
                      {pair.sources.map(s => (
                        <Link key={s.id} className="ak-chip ak-chip--source" to={`/note/${s.id}`}>→ {s.title}</Link>
                      ))}
                    </div>
                  )}
                  <div className="ak-answer__footer">
                    {pair.model && <span className="ak-model-tag">{pair.model}</span>}
                    <button
                      type="button"
                      className="ak-link-btn"
                      disabled={insertingId === pair.id}
                      onClick={() => insertIntoNote(pair)}
                    >
                      {insertingId === pair.id ? 'Adding…' : '+ Insert into new note'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
