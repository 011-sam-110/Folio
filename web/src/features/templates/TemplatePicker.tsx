// templates-nb — modal grid of template cards for "New note ▾". 'Blank note' first,
// then server templates (builtin first, then newest, per docs/API.md ordering). Also
// hosts a small in-place "Manage templates" view (list + delete with inline confirm).
import { useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import EmptyState from '../../components/EmptyState';
import Skeleton from '../../components/Skeleton';
import Icon from '../../components/Icon';
import { api } from '../../lib/api';
import type { Template } from '../../lib/types';
import { errorMessage } from '../../lib/format';
import { toast } from '../../components/Toast';
import { extractHeadings } from './headingPreview';
import './templates.css';

export interface TemplatePickerProps {
  open: boolean;
  onClose: () => void;
  /** null = "Blank note" was chosen (identical to the existing plain New-note behavior). */
  onPick: (template: Template | null) => void;
}

const BLANK_SENTINEL: Template = {
  id: '__blank__',
  name: 'Blank note',
  emoji: '📄',
  description: 'Start writing right away — no structure imposed.',
  contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  builtin: true,
  createdAt: '',
};

export default function TemplatePicker({ open, onClose, onPick }: TemplatePickerProps) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'pick' | 'manage'>('pick');

  function load() {
    setError(null);
    api
      .templates()
      .then((r) => setTemplates(r.templates))
      .catch((e) => setError(errorMessage(e, 'Could not load templates')));
  }

  useEffect(() => {
    if (!open) return;
    setMode('pick');
    setTemplates(null);
    load();
  }, [open]);

  const cards = templates ? [BLANK_SENTINEL, ...templates] : null;

  return (
    <Modal open={open} onClose={onClose} title={mode === 'pick' ? 'New note' : 'Manage templates'} width={580}>
      {mode === 'pick' ? (
        <>
          {!cards && !error && (
            <div className="tpl-grid" aria-hidden="true">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="tpl-card tpl-card--skeleton">
                  <Skeleton lines={3} />
                </div>
              ))}
            </div>
          )}

          {error && (
            <EmptyState
              icon="⚠️"
              title="Couldn't load templates"
              hint={error}
              action={
                <button type="button" className="btn btn-primary" onClick={load}>
                  Retry
                </button>
              }
            />
          )}

          {cards && !error && (
            <div className="tpl-grid" role="list">
              {cards.map((tpl) => {
                const isBlank = tpl.id === BLANK_SENTINEL.id;
                const heads = isBlank ? [] : extractHeadings(tpl.contentJson, 4);
                return (
                  // The button must stay a button: role="listitem" on it overrode the
                  // button role, so these cards announced as inert list items.
                  <div role="listitem" key={tpl.id} className="tpl-grid__cell">
                  <button
                    type="button"
                    className="tpl-card"
                    onClick={() => onPick(isBlank ? null : tpl)}
                  >
                    <div className="tpl-card__head">
                      <span className="tpl-card__emoji" aria-hidden="true">
                        {tpl.emoji}
                      </span>
                      <span className="tpl-card__name">{tpl.name}</span>
                    </div>
                    <div className="tpl-card__desc">{tpl.description || 'No description'}</div>
                    <div className="tpl-card__preview" aria-hidden="true">
                      {isBlank ? (
                        <span className="tpl-card__preview-empty">Empty page</span>
                      ) : heads.length > 0 ? (
                        heads.map((h, i) => (
                          <span key={i} className={`tpl-card__preview-line lvl-${Math.min(h.level, 3)}`}>
                            {h.text}
                          </span>
                        ))
                      ) : (
                        <span className="tpl-card__preview-empty">No headings</span>
                      )}
                    </div>
                  </button>
                  </div>
                );
              })}
            </div>
          )}

          {cards && (
            <button type="button" className="tpl-manage-link" onClick={() => setMode('manage')}>
              <Icon name="layers" size={13} /> Manage templates
            </button>
          )}
        </>
      ) : (
        <ManageView
          templates={templates ?? []}
          onBack={() => setMode('pick')}
          onChanged={load}
        />
      )}
    </Modal>
  );
}

function ManageView({
  templates,
  onBack,
  onChanged,
}: {
  templates: Template[];
  onBack: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <div className="tpl-manage-list">
        {templates.length === 0 ? (
          <EmptyState
            icon="🗂️"
            title="No templates yet"
            hint="Save any note as a template from its ⋯ menu → Save as template."
          />
        ) : (
          templates.map((tpl) => <ManageRow key={tpl.id} template={tpl} onDeleted={onChanged} />)
        )}
      </div>
      <button type="button" className="tpl-manage-link" onClick={onBack}>
        <Icon name="chevron-left" size={12} /> Back to templates
      </button>
    </>
  );
}

function ManageRow({ template, onDeleted }: { template: Template; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    setBusy(true);
    try {
      await api.deleteTemplate(template.id);
      toast(`Deleted "${template.name}"`, 'ok');
      onDeleted();
    } catch (e) {
      toast(errorMessage(e, 'Could not delete template'), 'error');
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="tpl-manage-row">
      <span className="tpl-manage-row__emoji" aria-hidden="true">
        {template.emoji}
      </span>
      <div className="tpl-manage-row__main">
        <div className="tpl-manage-row__name">
          {template.name}
          {template.builtin && <span className="tpl-manage-row__badge">Built-in</span>}
        </div>
        {template.description && <div className="tpl-manage-row__desc">{template.description}</div>}
      </div>
      {confirming ? (
        <div className="tpl-manage-row__confirm">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={doDelete} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="icon-btn danger"
          aria-label={`Delete ${template.name}`}
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" size={14} />
        </button>
      )}
    </div>
  );
}
