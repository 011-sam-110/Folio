// Generic AI result preview: BEFORE (muted plain text) / AFTER (rendered markdown),
// with a caller-supplied set of primary/secondary actions plus a built-in Discard.
import Modal from '../../components/Modal';
import { markdownToSafeHtml } from './markdown';

export interface AiPreviewAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface AiPreviewModalProps {
  open: boolean;
  onClose: () => void;
  heading: string;
  model?: string;
  before?: string | null;
  afterMarkdown: string;
  actions: AiPreviewAction[];
}

export default function AiPreviewModal({ open, onClose, heading, model, before, afterMarkdown, actions }: AiPreviewModalProps) {
  const afterHtml = markdownToSafeHtml(afterMarkdown);

  return (
    <Modal open={open} onClose={onClose} title={heading} width={760}>
      <div className="folio-ai-modal" data-testid="ai-preview-modal">
        {model && <div className="folio-ai-model">✨ {model}</div>}
        <div className={`folio-ai-preview${before != null ? ' folio-ai-preview-split' : ''}`}>
          {before != null && (
            <div className="folio-ai-col folio-ai-before">
              <div className="folio-ai-col-label">Before</div>
              <div className="folio-ai-before-text">{before || '(empty)'}</div>
            </div>
          )}
          <div className="folio-ai-col folio-ai-after">
            <div className="folio-ai-col-label">After</div>
            {/* eslint-disable-next-line react/no-danger */}
            <div className="folio-ai-after-html" dangerouslySetInnerHTML={{ __html: afterHtml }} />
          </div>
        </div>
        <div className="folio-ai-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={a.primary ? 'folio-btn-primary' : 'folio-btn'}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
          <button type="button" className="folio-btn-ghost" onClick={onClose}>
            Discard
          </button>
        </div>
      </div>
    </Modal>
  );
}
