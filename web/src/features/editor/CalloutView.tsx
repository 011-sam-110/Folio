// NodeView for a Callout block: clickable emoji (small picker) + tone dots in a
// non-editable header, editable body below.
import { useState } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';

const EMOJIS = ['💡', 'ℹ️', '⚠️', '✅', '📌', '🔥', '❗', '📝', '🎯', '⭐', '🧭', '🚧'];
const TONES: Array<{ id: 'info' | 'warn' | 'ok'; label: string }> = [
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Warning' },
  { id: 'ok', label: 'Success' },
];

export default function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const emoji = (node.attrs.emoji as string) || '💡';
  const tone = (node.attrs.tone as string) || 'info';
  const editable = editor.isEditable;

  return (
    <NodeViewWrapper className={`folio-callout folio-callout-${tone}`} data-tone={tone}>
      <div className="folio-callout-head" contentEditable={false}>
        <span className="folio-callout-emoji-wrap">
          <button
            type="button"
            className="folio-callout-emoji"
            disabled={!editable}
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="Change callout icon"
          >
            {emoji}
          </button>
          {pickerOpen && (
            <div className="folio-callout-picker" onMouseLeave={() => setPickerOpen(false)}>
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    updateAttributes({ emoji: e });
                    setPickerOpen(false);
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </span>
        {editable && (
          <div className="folio-callout-tones">
            {TONES.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.label}
                aria-label={t.label}
                className={`folio-callout-tone folio-callout-tone-${t.id}${tone === t.id ? ' active' : ''}`}
                onClick={() => updateAttributes({ tone: t.id })}
              />
            ))}
          </div>
        )}
      </div>
      <NodeViewContent className="folio-callout-body" />
    </NodeViewWrapper>
  );
}
