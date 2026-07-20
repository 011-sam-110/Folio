// web-shell — app sidebar: wordmark, search trigger, nav, notebook list with
// inline rename/emoji/color/archive/delete, new-notebook form, footer
// (theme toggle, phone capture, AI status).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import HashGlyph from './HashGlyph';
import { api } from '../lib/api';
import type { Notebook } from '../lib/types';
import { errorMessage } from '../lib/format';
import { useNotebooks } from './NotebooksContext';
import { toast } from './Toast';
import { useTheme } from '../lib/theme';
import { useAiEnabled } from '../lib/aiPrefs';
import { useAiHealth } from '../lib/aiStatus';
import Icon from './Icon';
import Tooltip from './Tooltip';
import EmojiPicker from './EmojiPicker';
import ContextMenu, { menuItem, menuDivider, type MenuEntry } from './ContextMenu';
import ConfirmDialog from './ConfirmDialog';
import Modal from './Modal';
import Spinner from './Spinner';
import Skeleton from './Skeleton';
import AccountMenu from '../features/auth/AccountMenu';

const NOTEBOOK_PALETTE = [
  { name: 'Gray', hex: '#78716c' },
  { name: 'Brown', hex: '#92400e' },
  { name: 'Orange', hex: '#ea580c' },
  { name: 'Yellow', hex: '#ca8a04' },
  { name: 'Green', hex: '#16a34a' },
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Purple', hex: '#7c3aed' },
  { name: 'Pink', hex: '#db2777' },
  { name: 'Red', hex: '#dc2626' },
];

export interface SidebarProps {
  /** Collapse the sidebar (the expand affordance lives in App.tsx, since
   *  this component's own DOM is clipped away once collapsed). */
  onCollapse: () => void;
  onCloseMobile: () => void;
  onOpenSearch: () => void;
  onNewNote: () => void;
  /** Creates a note with kind='canvas' — an infinite board rather than a document. */
  onNewCanvas: () => void;
  currentNotebookId?: string;
  /** Phone-capture QR modal — state lives in App.tsx so the command
   *  palette's "Open phone capture QR" command can trigger the same modal. */
  qrOpen: boolean;
  onOpenQr: () => void;
  onCloseQr: () => void;
  /** Opens the Ctrl/Cmd+P command palette (footer affordance for mouse users). */
  onOpenCommandPalette: () => void;
}

export default function Sidebar({
  onCollapse,
  onCloseMobile,
  onOpenSearch,
  onNewNote,
  onNewCanvas,
  currentNotebookId,
  qrOpen,
  onOpenQr,
  onCloseQr,
  onOpenCommandPalette,
}: SidebarProps) {
  const { notebooks, loading, error, reload, createNotebook, updateNotebook, deleteNotebook } = useNotebooks();
  const [theme, , toggleTheme] = useTheme();
  const [aiOn, setAiOn] = useAiEnabled();
  const navigate = useNavigate();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState('📓');
  const [submittingNew, setSubmittingNew] = useState(false);

  const [studyDue, setStudyDue] = useState<number | null>(null);
  // Shared probe (lib/aiStatus) rather than a local one, so the status dot here and
  // the gating of every AI affordance elsewhere always agree and cost one request.
  const aiHealth = useAiHealth();

  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const newNameRef = useRef<HTMLInputElement | null>(null);

  const visibleNotebooks = notebooks.filter((n) => !n.archived);

  useEffect(() => {
    api.studyStats().then((s) => setStudyDue(s.due)).catch(() => setStudyDue(null));
    const t = setInterval(() => {
      api.studyStats().then((s) => setStudyDue(s.due)).catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    if (creatingNotebook) newNameRef.current?.focus();
  }, [creatingNotebook]);

  function startRename(nb: Notebook) {
    setRenamingId(nb.id);
    setRenameValue(nb.name);
  }

  async function commitRename(nb: Notebook) {
    const value = renameValue.trim();
    setRenamingId(null);
    if (!value || value === nb.name) return;
    try {
      await updateNotebook(nb.id, { name: value });
    } catch (e) {
      toast(errorMessage(e, 'Could not rename notebook'), 'error');
    }
  }

  async function archiveNotebook(nb: Notebook) {
    try {
      await updateNotebook(nb.id, { archived: true });
      toast(`${nb.name} archived`, 'ok');
    } catch (e) {
      toast(errorMessage(e, 'Could not archive notebook'), 'error');
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteNotebook(deleteTarget.id);
      toast(`${deleteTarget.name} deleted`, 'ok');
      if (currentNotebookId === deleteTarget.id) navigate('/');
      setDeleteTarget(null);
    } catch (e) {
      toast(errorMessage(e, 'Could not delete notebook'), 'error');
    } finally {
      setDeleting(false);
    }
  }

  async function submitNewNotebook(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setSubmittingNew(true);
    try {
      await createNotebook({ name, emoji: newEmoji });
      toast('Notebook created', 'ok');
      setNewName('');
      setNewEmoji('📓');
      setCreatingNotebook(false);
    } catch (e2) {
      toast(errorMessage(e2, 'Could not create notebook'), 'error');
    } finally {
      setSubmittingNew(false);
    }
  }

  function notebookMenuItems(nb: Notebook): MenuEntry[] {
    return [
      menuItem({ key: 'rename', label: 'Rename', icon: 'pencil', onSelect: () => startRename(nb) }),
      menuItem({
        key: 'color',
        label: 'Color',
        icon: 'palette',
        submenu: NOTEBOOK_PALETTE.map((c) =>
          menuItem({
            key: c.hex,
            label: c.name,
            colorDot: c.hex,
            onSelect: () => {
              updateNotebook(nb.id, { color: c.hex }).catch((e) =>
                toast(errorMessage(e, 'Could not update color'), 'error'),
              );
            },
          }),
        ),
      }),
      menuDivider('d1'),
      menuItem({ key: 'archive', label: 'Archive', icon: 'archive', onSelect: () => archiveNotebook(nb) }),
      menuItem({ key: 'delete', label: 'Delete…', icon: 'trash', danger: true, onSelect: () => setDeleteTarget(nb) }),
    ];
  }

  return (
    <nav className="sidebar" aria-label="Folio">
      <div className="sidebar__brand">
        <span className="sidebar__brand-mark" aria-hidden="true">📓</span>
        <span className="sidebar__brand-name">Folio</span>
        <Tooltip content={<>Collapse sidebar <kbd>⌘\</kbd></>} placement="right">
          <button
            type="button"
            className="icon-btn sidebar__collapse-btn"
            aria-label="Collapse sidebar"
            onClick={onCollapse}
          >
            <Icon name="chevron-left" size={15} />
          </button>
        </Tooltip>
      </div>

      <div className="sidebar__search">
        <button type="button" className="sidebar__search-btn" onClick={onOpenSearch}>
          <Icon name="search" size={14} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
      </div>

      <div className="sidebar__nav">
        <NavLink to="/" end className={({ isActive }) => `sidebar__nav-link${isActive ? ' active' : ''}`} onClick={onCloseMobile}>
          <Icon name="home" size={15} />
          <span>Home</span>
        </NavLink>
        <NavLink to="/study" className={({ isActive }) => `sidebar__nav-link${isActive ? ' active' : ''}`} onClick={onCloseMobile}>
          <Icon name="layers" size={15} />
          <span>Study</span>
          {!!studyDue && <span className="sidebar__nav-badge">{studyDue}</span>}
        </NavLink>
        {aiOn && (
          <NavLink to="/ask" className={({ isActive }) => `sidebar__nav-link${isActive ? ' active' : ''}`} onClick={onCloseMobile}>
            <Icon name="sparkles" size={15} />
            <span>Ask AI</span>
          </NavLink>
        )}
        <NavLink to="/search" className={({ isActive }) => `sidebar__nav-link${isActive ? ' active' : ''}`} onClick={onCloseMobile}>
          <Icon name="search" size={15} />
          <span>Search</span>
        </NavLink>
        <NavLink to="/tags" className={({ isActive }) => `sidebar__nav-link${isActive ? ' active' : ''}`} onClick={onCloseMobile}>
          <HashGlyph size={15} />
          <span>Tags</span>
        </NavLink>
      </div>

      <div className="sidebar__divider" />
      <div className="sidebar__section-label">
        <span>Notebooks</span>
        {/* Sized by class, not an inline 20px box: 20px is below the WCAG 2.5.8
            minimum, and the modifier still leaves the section-label row compact. */}
        <Tooltip content="New canvas" placement="right">
          <button type="button" className="icon-btn icon-btn--xs" aria-label="New canvas" onClick={onNewCanvas}>
            <Icon name="canvas" size={13} />
          </button>
        </Tooltip>
        <Tooltip content="New note (⌘N)" placement="right">
          <button type="button" className="icon-btn icon-btn--xs" aria-label="New note" onClick={onNewNote}>
            <Icon name="plus" size={13} />
          </button>
        </Tooltip>
      </div>

      <div className="sidebar__notebooks">
        {loading && notebooks.length === 0 && (
          <div style={{ padding: '4px 10px' }}>
            <Skeleton lines={4} />
          </div>
        )}
        {!loading && error && (
          <div style={{ padding: '6px 10px', fontSize: 12.5, color: 'var(--ink-2)' }}>
            Couldn't load notebooks.{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && visibleNotebooks.length === 0 && (
          <div style={{ padding: '6px 10px', fontSize: 12.5, color: 'var(--ink-3)' }}>No notebooks yet.</div>
        )}
        {visibleNotebooks.map((nb) => (
          <div
            key={nb.id}
            className={`notebook-row${currentNotebookId === nb.id ? ' active' : ''}${openMenuId === nb.id ? ' is-menu-open' : ''}`}
          >
            {renamingId === nb.id ? (
              <>
                <span className="notebook-row__emoji" aria-hidden="true">{nb.emoji}</span>
                <input
                  ref={renameInputRef}
                  className="notebook-row__rename-input"
                  // No label, no placeholder, and the only adjacent context is an
                  // aria-hidden emoji — this field was entirely unnamed.
                  aria-label={`Rename notebook ${nb.name}`}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(nb);
                    else if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => commitRename(nb)}
                  onClick={(e) => e.stopPropagation()}
                />
              </>
            ) : (
              <>
                <EmojiPicker
                  value={nb.emoji}
                  size={13}
                  label={`Change emoji for ${nb.name}`}
                  onSelect={(emoji) =>
                    updateNotebook(nb.id, { emoji }).catch((e) => toast(errorMessage(e, 'Could not update emoji'), 'error'))
                  }
                />
                <NavLink to={`/notebook/${nb.id}`} className="notebook-row__link" onClick={onCloseMobile}>
                  <span className="notebook-row__name">{nb.name}</span>
                </NavLink>
              </>
            )}
            {renamingId !== nb.id && (
              <>
                <span className="notebook-row__count">{nb.noteCount}</span>
                <ContextMenu
                  trigger={<Icon name="more" size={14} />}
                  items={notebookMenuItems(nb)}
                  ariaLabel={`${nb.name} options`}
                  triggerClassName={`notebook-row__more${openMenuId === nb.id ? ' is-open' : ''}`}
                  onOpenChange={(o) => setOpenMenuId(o ? nb.id : null)}
                />
              </>
            )}
          </div>
        ))}
      </div>

      <div className="sidebar__new-notebook">
        {!creatingNotebook ? (
          <button type="button" className="sidebar__new-notebook-btn" onClick={() => setCreatingNotebook(true)}>
            <Icon name="plus" size={13} />
            <span>New notebook</span>
          </button>
        ) : (
          <form className="sidebar__new-notebook-form" onSubmit={submitNewNotebook}>
            <EmojiPicker value={newEmoji} size={14} label="Notebook emoji" onSelect={setNewEmoji} />
            <input
              ref={newNameRef}
              type="text"
              aria-label="Notebook name"
              value={newName}
              placeholder="Notebook name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setCreatingNotebook(false);
                  setNewName('');
                }
              }}
            />
            <button type="submit" className="icon-btn" aria-label="Create notebook" disabled={!newName.trim() || submittingNew}>
              {submittingNew ? <Spinner size={13} /> : <Icon name="check" size={14} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Cancel"
              onClick={() => {
                setCreatingNotebook(false);
                setNewName('');
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </form>
        )}
      </div>

      <AccountMenu />

      <div className="sidebar__footer">
        <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <button type="button" className="sidebar__icon-btn" aria-label="Toggle theme" onClick={toggleTheme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
          </button>
        </Tooltip>
        <Tooltip content="Phone capture — scan to add notes from your phone">
          <button type="button" className="sidebar__icon-btn" aria-label="Phone capture" onClick={onOpenQr}>
            <Icon name="phone" size={15} />
          </button>
        </Tooltip>
        <Tooltip content={<>Command palette <kbd>⌘P</kbd></>}>
          <button type="button" className="sidebar__icon-btn" aria-label="Command palette" onClick={onOpenCommandPalette}>
            <Icon name="more" size={16} />
          </button>
        </Tooltip>
        <Tooltip
          content={
            aiOn
              ? 'Turn off all AI features — Folio becomes a plain notebook'
              : 'AI features are off — click to turn them back on'
          }
        >
          <button
            type="button"
            className={`sidebar__icon-btn${aiOn ? '' : ' is-ai-off'}`}
            aria-label={aiOn ? 'Turn off AI features' : 'Turn on AI features'}
            data-testid="ai-toggle"
            onClick={() => {
              setAiOn(!aiOn);
              toast(aiOn ? 'AI features turned off — your notes are yours alone' : 'AI features turned back on', 'ok');
            }}
          >
            <Icon name={aiOn ? 'sparkles' : 'sparkles-off'} size={15} />
          </button>
        </Tooltip>
        {aiOn && (
          <Tooltip
            content={
              aiHealth.status === 'ok'
                ? `AI online${aiHealth.model ? ` · ${aiHealth.model}` : ''}`
                : aiHealth.status === 'bad'
                  ? `AI offline${aiHealth.error ? ` · ${aiHealth.error}` : ''}`
                  : 'Checking AI status…'
            }
          >
            <span className="sidebar__ai-status">
              <span className={`sidebar__ai-dot ${aiHealth.status}`} />
            </span>
          </Tooltip>
        )}
      </div>

      <PhoneCaptureModal open={qrOpen} onClose={onCloseQr} />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete "${deleteTarget?.name ?? ''}"?`}
        message={
          <>
            This permanently deletes the notebook and all {deleteTarget?.noteCount ?? 0} note
            {deleteTarget?.noteCount === 1 ? '' : 's'} inside it. This can't be undone.
          </>
        }
        confirmLabel="Delete notebook"
        danger
        loading={deleting}
        requireText={deleteTarget?.name}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </nav>
  );
}

function PhoneCaptureModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<{ url: string; dataUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api
      .qr()
      .then((res) => setData({ url: res.url, dataUrl: res.dataUrl }))
      .catch((e) => setError(errorMessage(e, "Couldn't generate a QR code")))
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Phone capture" width={360}>
      <div style={{ textAlign: 'center' }}>
        {loading && (
          <div style={{ padding: '30px 0' }}>
            <Spinner size={26} />
          </div>
        )}
        {!loading && error && (
          <div style={{ padding: '16px 0', fontSize: 13, color: 'var(--ink-2)' }}>{error}</div>
        )}
        {!loading && data && (
          <>
            <img
              src={data.dataUrl}
              alt={`QR code linking to ${data.url}`}
              width={220}
              height={220}
              style={{ margin: '0 auto', borderRadius: 8, border: '1px solid var(--line)' }}
            />
            <div style={{ marginTop: 12, fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--ink-2)', wordBreak: 'break-all' }}>
              {data.url}/capture
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              Scan with your phone's camera on the same Wi-Fi. If it can't connect, check that Mullvad
              (or any VPN) is off — VPNs block traffic to your LAN.
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
