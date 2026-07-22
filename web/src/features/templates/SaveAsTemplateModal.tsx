// templates-nb - the actual modal UI mounted imperatively by saveAsTemplate.ts. Not
// meant to be rendered directly by other agents' code; they call saveNoteAsTemplate(note)
// instead (see saveAsTemplate.ts for why this can be self-mounting).
import { useState } from 'react';
import Modal from '../../components/Modal';
import EmojiPicker from '../../components/EmojiPicker';
import Spinner from '../../components/Spinner';
import { api } from '../../lib/api';
import type { Note } from '../../lib/types';
import { errorMessage } from '../../lib/format';
import { toast } from '../../components/Toast';
import './templates.css';

export default function SaveAsTemplateModal({ note, onDone }: { note: Note; onDone: () => void }) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(note.title || 'Untitled template');
  const [emoji, setEmoji] = useState('📄');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  function close() {
    setOpen(false);
    // Modal unmounts synchronously once `open` is false; defer the root teardown one
    // tick so its own cleanup effects (focus restore, body scroll) run first.
    setTimeout(onDone, 0);
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await api.createTemplate({
        name: trimmed,
        emoji,
        description: description.trim(),
        contentJson: note.contentJson,
      });
      toast(`Saved "${trimmed}" as a template`, 'ok');
      close();
    } catch (e) {
      toast(errorMessage(e, 'Could not save template'), 'error');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Save as template" width={420}>
      <div className="tpl-save-form">
        <div className="tpl-save-form__row">
          <EmojiPicker value={emoji} size={30} label="Template emoji" onSelect={setEmoji} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <label className="field-label" htmlFor="tpl-save-name">
              Name
            </label>
            <input
              id="tpl-save-name"
              className="text-input"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor="tpl-save-desc">
            Description
          </label>
          <input
            id="tpl-save-desc"
            className="text-input"
            placeholder="What's this template for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
        </div>
        <div className="tpl-save-form__actions">
          <button type="button" className="btn btn-secondary" onClick={close} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>
            {saving && <Spinner size={13} />}
            Save template
          </button>
        </div>
      </div>
    </Modal>
  );
}
