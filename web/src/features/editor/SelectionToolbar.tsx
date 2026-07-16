// BubbleMenu shown on a non-empty text selection: formatting marks, a link popover,
// and an "AI" quick-instruction submenu that opens AiPreviewModal on completion.
import { useEffect, useRef, useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../components/Toast';
import Icon from '../../components/Icon';
import AiPreviewModal from './AiPreviewModal';
import { markdownToSafeHtml } from './markdown';

const AI_INSTRUCTIONS = [
  { id: 'improve', label: 'Improve', instruction: 'Improve the writing: clarity, flow and correctness. Keep the meaning and roughly the same length.' },
  { id: 'shorten', label: 'Shorten', instruction: 'Make this significantly more concise while keeping the key meaning.' },
  { id: 'expand', label: 'Expand', instruction: 'Expand this with more detail and explanation.' },
  { id: 'fix', label: 'Fix grammar', instruction: 'Fix grammar and spelling only; do not change the meaning or style.' },
  { id: 'explain', label: 'Explain simpler', instruction: 'Rewrite this to be much easier to understand, as if explaining to a beginner.' },
];

interface AiResult {
  before: string;
  after: string;
  model: string;
  range: { from: number; to: number };
}

function aiErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 502) return 'AI offline — is the gateway running?';
  return e instanceof Error ? e.message : 'AI request failed';
}

export default function SelectionToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<AiResult | null>(null);

  // Pin the AI-edit target range by mapping it through every transaction that lands while
  // the request is in flight (and while the preview modal is open). Without this, applying
  // "Replace selection" used the positions captured BEFORE the round trip — typing anywhere
  // above the selection shifted the doc and the result landed at the wrong spot (or threw).
  const trackedRangeRef = useRef<{ from: number; to: number } | null>(null);
  const trackerAttachedRef = useRef(false);

  useEffect(() => {
    function onTransaction({ transaction }: { transaction: Transaction }) {
      const r = trackedRangeRef.current;
      if (!r || !transaction.docChanged) return;
      r.from = transaction.mapping.map(r.from, 1);
      r.to = transaction.mapping.map(r.to, -1);
      if (r.to < r.from) r.to = r.from;
    }
    editor.on('transaction', onTransaction);
    trackerAttachedRef.current = true;
    return () => {
      editor.off('transaction', onTransaction);
      trackerAttachedRef.current = false;
    };
  }, [editor]);

  /** The tracked range, clamped to the current doc (defensive against deletions). */
  function currentTargetRange(fallback: { from: number; to: number }): { from: number; to: number } {
    const r = trackedRangeRef.current ?? fallback;
    const max = editor.state.doc.content.size;
    const from = Math.max(0, Math.min(r.from, max));
    const to = Math.max(from, Math.min(r.to, max));
    return { from, to };
  }

  function clearAiResult() {
    trackedRangeRef.current = null;
    setAiResult(null);
  }

  function openLink() {
    const attrs = editor.getAttributes('link');
    setLinkValue((attrs.href as string) || '');
    setLinkOpen(true);
    setAiOpen(false);
  }

  function applyLink() {
    const href = linkValue.trim();
    if (!href) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    setLinkOpen(false);
  }

  async function runAi(instruction: string) {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n');
    if (!text.trim()) return;
    setAiOpen(false);
    setAiLoading(true);
    trackedRangeRef.current = { from, to }; // live-mapped from here on
    try {
      const res = await api.aiImprove({ text, instruction });
      setAiResult({ before: text, after: res.markdown, model: res.model, range: { from, to } });
    } catch (e) {
      trackedRangeRef.current = null;
      toast(aiErrorMessage(e), 'error');
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <>
      <BubbleMenu
        editor={editor}
        pluginKey="folioSelectionMenu"
        // flip to below the selection when there's no room above (never cover the selected
        // line); shift keeps it inside the viewport horizontally.
        options={{ placement: 'top', offset: 8, flip: { fallbackPlacements: ['bottom'], padding: 8 }, shift: { padding: 8 } }}
        shouldShow={({ editor, state }) => {
          const { empty } = state.selection;
          if (empty) return false;
          if (editor.isActive('table') || editor.isActive('image') || editor.isActive('codeBlock')) return false;
          return true;
        }}
      >
        <div className="folio-bubble folio-selection-bubble">
          <button type="button" className={editor.isActive('bold') ? 'active' : ''} title="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
            <b>B</b>
          </button>
          <button type="button" className={editor.isActive('italic') ? 'active' : ''} title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
            <i>I</i>
          </button>
          <button type="button" className={editor.isActive('strike') ? 'active' : ''} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
            <s>S</s>
          </button>
          <button type="button" className={editor.isActive('code') ? 'active' : ''} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>
            {'</>'}
          </button>
          <button type="button" className={editor.isActive('highlight') ? 'active' : ''} title="Highlight" onClick={() => editor.chain().focus().toggleHighlight().run()}>
            ◆
          </button>
          <button type="button" className={editor.isActive('link') ? 'active' : ''} title="Link" onClick={openLink}>
            <Icon name="link" size={14} />
          </button>
          <span className="folio-bubble-sep" />
          <div className="folio-ai-trigger">
            <button type="button" className="folio-ai-btn" disabled={aiLoading} onClick={() => setAiOpen((v) => !v)}>
              {aiLoading ? '…' : <><Icon name="sparkles" size={13} /> AI</>}
            </button>
            {aiOpen && (
              <div className="folio-ai-dropdown" onMouseLeave={() => setAiOpen(false)}>
                {AI_INSTRUCTIONS.map((o) => (
                  <button key={o.id} type="button" onClick={() => runAi(o.instruction)}>
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {linkOpen && (
          <div className="folio-link-popover" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={linkValue}
              placeholder="https://…"
              onChange={(e) => setLinkValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyLink();
                if (e.key === 'Escape') setLinkOpen(false);
              }}
            />
            <button type="button" onClick={applyLink}>{linkValue.trim() ? 'Apply' : 'Remove'}</button>
          </div>
        )}
      </BubbleMenu>

      {aiResult && (
        <AiPreviewModal
          open
          onClose={clearAiResult}
          heading="AI edit"
          model={aiResult.model}
          before={aiResult.before}
          afterMarkdown={aiResult.after}
          actions={[
            {
              label: 'Replace selection',
              primary: true,
              onClick: () => {
                const html = markdownToSafeHtml(aiResult.after);
                editor.chain().focus().insertContentAt(currentTargetRange(aiResult.range), html).run();
                clearAiResult();
              },
            },
            {
              label: 'Insert below',
              onClick: () => {
                const html = markdownToSafeHtml(aiResult.after);
                editor.chain().focus().insertContentAt(currentTargetRange(aiResult.range).to, html).run();
                clearAiResult();
              },
            },
            {
              label: 'Copy',
              onClick: () => {
                navigator.clipboard?.writeText(aiResult.after).then(
                  () => toast('Copied', 'ok'),
                  () => toast('Could not copy', 'error'),
                );
              },
            },
          ]}
        />
      )}
    </>
  );
}
