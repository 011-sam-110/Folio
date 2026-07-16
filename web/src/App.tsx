import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { NotebooksProvider, useNotebooks } from './components/NotebooksContext';
import Sidebar from './components/Sidebar';
import QuickSwitcher from './components/QuickSwitcher';
import { Toaster, toast } from './components/Toast';
import Icon from './components/Icon';
import Tooltip from './components/Tooltip';
import { useShortcuts } from './lib/useShortcuts';
import { api } from './lib/api';
import { errorMessage } from './lib/format';
import ImportModal from './features/import/ImportModal';
import { _subscribeImportModal, type OpenImportModalArgs } from './components/importModalBus';

const COLLAPSE_KEY = 'folio:sidebarCollapsed';

function getPersistedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function useIsMobile(breakpoint = 899): boolean {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return isMobile;
}

export default function App() {
  return (
    <NotebooksProvider>
      <AppShell />
    </NotebooksProvider>
  );
}

function AppShell() {
  const { notebooks } = useNotebooks();
  const navigate = useNavigate();
  // useParams merges dynamic segments from every matched route in the tree,
  // so this picks up :notebookId even though App itself owns the "/" layout
  // route and doesn't declare that param.
  const params = useParams<{ notebookId?: string }>();
  const isMobile = useIsMobile();

  const [collapsed, setCollapsed] = useState(getPersistedCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // localStorage unavailable (private mode, etc) — collapse state just won't persist.
    }
  }, [collapsed]);

  const handleNewNote = useCallback(async () => {
    const notebookId = params.notebookId || notebooks[0]?.id;
    if (!notebookId) {
      toast('Create a notebook first', 'error');
      return;
    }
    try {
      const { note } = await api.createNote({ notebookId });
      navigate(`/note/${note.id}`);
    } catch (e) {
      toast(errorMessage(e, 'Could not create note'), 'error');
    }
  }, [params.notebookId, notebooks, navigate]);

  useShortcuts({
    onQuickSwitcher: () => setQuickSwitcherOpen((o) => !o),
    onNewNote: handleNewNote,
    onFocusSearch: () => setQuickSwitcherOpen(true),
    onToggleSidebar: () => setCollapsed((c) => !c),
  });

  return (
    <>
      <div className="app-topbar">
        <button type="button" className="icon-btn" aria-label="Open menu" onClick={() => setMobileOpen(true)}>
          <Icon name="menu" size={18} />
        </button>
        <div className="app-topbar__brand">
          <span aria-hidden="true">📓</span>
          <span>Folio</span>
        </div>
        <div className="app-topbar__spacer" />
        <button type="button" className="icon-btn" aria-label="Search notes" onClick={() => setQuickSwitcherOpen(true)}>
          <Icon name="search" size={17} />
        </button>
      </div>

      <div
        className={`app-scrim${mobileOpen ? ' is-visible' : ''}`}
        aria-hidden="true"
        onClick={() => setMobileOpen(false)}
      />

      <div className="app-shell">
        <div className="app-sidebar-wrap" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
          <Sidebar
            onCollapse={() => setCollapsed(true)}
            onCloseMobile={() => setMobileOpen(false)}
            onOpenSearch={() => setQuickSwitcherOpen(true)}
            onNewNote={handleNewNote}
            currentNotebookId={params.notebookId}
          />
        </div>

        {collapsed && !isMobile && (
          <Tooltip content={<>Expand sidebar <kbd>⌘\</kbd></>} placement="right">
            <button
              type="button"
              className="icon-btn app-expand-btn"
              aria-label="Expand sidebar"
              onClick={() => setCollapsed(false)}
            >
              <Icon name="chevron-right" size={15} />
            </button>
          </Tooltip>
        )}

        <main className="app-main">
          <Outlet />
        </main>
      </div>

      <Toaster />
      <QuickSwitcher
        open={quickSwitcherOpen}
        onClose={() => setQuickSwitcherOpen(false)}
        currentNotebookId={params.notebookId}
      />
      <ImportModalHost />
    </>
  );
}

function ImportModalHost() {
  const [state, setState] = useState<{ open: boolean } & OpenImportModalArgs>({ open: false });

  useEffect(() => _subscribeImportModal((args) => setState({ open: true, ...args })), []);

  return (
    <ImportModal
      open={state.open}
      onClose={() => setState((s) => ({ ...s, open: false }))}
      notebookId={state.notebookId}
      noteId={state.noteId}
      defaultKind={state.defaultKind}
    />
  );
}
