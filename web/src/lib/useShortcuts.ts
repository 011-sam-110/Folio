// Owned by web-shell (may be replaced; keep exported signatures).
//
// Global keyboard shortcut hub. Individual overlays (Modal, QuickSwitcher,
// menus) own their own Escape handling locally - this hook only owns the
// app-wide chords that must work from anywhere: quick switcher, new note,
// focus search, and the sidebar collapse toggle.
import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  /** Ctrl/Cmd+K - open the quick switcher. */
  onQuickSwitcher?: () => void;
  /** Ctrl/Cmd+N - new note in the current (or first) notebook. */
  onNewNote?: () => void;
  /** Ctrl/Cmd+Shift+F - focus full search. */
  onFocusSearch?: () => void;
  /** Ctrl/Cmd+\ - toggle sidebar collapse. */
  onToggleSidebar?: () => void;
  /** Ctrl/Cmd+P - open the command palette. Always intercepted (even while
   *  typing) so it never falls through to the browser's print dialog. */
  onCommandPalette?: () => void;
  /** `?` - open the keyboard shortcut cheatsheet. Unmodified, so unlike every
   *  other binding here it must yield while the user is typing: `?` is a real
   *  character in a note. */
  onShortcutsHelp?: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/**
 * Registers the global shortcut set for the lifetime of the calling
 * component. Handlers are read from a ref so callers can pass a fresh
 * object every render without re-binding the listener.
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // The one unmodified binding. Checked before the `mod` guard below, and only
      // ever outside a text field - `?` has to keep working as a question mark.
      if (!mod && e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault();
        ref.current.onShortcutsHelp?.();
        return;
      }

      if (!mod) return;
      const key = e.key.toLowerCase();
      const typing = isTypingTarget(e.target);

      // Quick switcher always works, even while typing in a field.
      if (key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        ref.current.onQuickSwitcher?.();
        return;
      }

      // Command palette always works too, and must always block the
      // browser's print dialog - including while focused in the editor.
      if (key === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        ref.current.onCommandPalette?.();
        return;
      }

      if (typing) return;

      if (key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        ref.current.onNewNote?.();
        return;
      }

      if (key === 'f' && e.shiftKey) {
        e.preventDefault();
        ref.current.onFocusSearch?.();
        return;
      }

      if (key === '\\') {
        e.preventDefault();
        ref.current.onToggleSidebar?.();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
