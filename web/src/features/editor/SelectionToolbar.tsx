// BubbleMenu shown on a non-empty text selection: formatting marks, a link popover,
// and an "AI ✨" quick-instruction submenu that opens AiPreviewModal on completion.
import { useState } from 'react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/core';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../components/Toast';
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
    try {
      const res = await api.aiImprove({ text, instruction });
      setAiResult({ before: text, after: res.markdown, model: res.model, range: { from, to } });
    } catch (e) {
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
        options={{ placement: 'top', offset: 8 }}
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
            🔗
          </button>
          <span className="folio-bubble-sep" />
          <div className="folio-ai-trigger">
            <button type="button" className="folio-ai-btn" disabled={aiLoading} onClick={() => setAiOpen((v) => !v)}>
              {aiLoading ? '…' : '✨ AI'}
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
          onClose={() => setAiResult(null)}
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
                editor.chain().focus().insertContentAt(aiResult.range, html).run();
                setAiResult(null);
              },
            },
            {
              label: 'Insert below',
              onClick: () => {
                const html = markdownToSafeHtml(aiResult.after);
                editor.chain().focus().insertContentAt(aiResult.range.to, html).run();
                setAiResult(null);
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
