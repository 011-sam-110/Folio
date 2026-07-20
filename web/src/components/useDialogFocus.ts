import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal-dialog focus behaviour for overlays that don't use `Modal`.
 *
 * The palette-style overlays (CommandPalette, QuickSwitcher) each declared
 * `role="dialog" aria-modal="true"` but implemented none of the behaviour the
 * role promises: Tab walked straight out into the page behind, and Escape was a
 * React `onKeyDown` on the panel, so it silently stopped working the moment focus
 * left the panel — which, with no trap, happened on the very first Tab.
 *
 * Handles: initial focus, Tab/Shift+Tab wrap, Escape at the document level
 * (capture phase, so it works wherever focus currently is), focus restore to the
 * trigger, and body scroll lock.
 *
 * `onClose` is read through a ref internally, so callers may pass a fresh closure
 * each render without the effect tearing down and stealing focus back.
 */
export function useDialogFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  // Some panels own their own initial focus (a search input they also select text
  // in). Those pass false so this hook does not fight them for it.
  takeInitialFocus = true,
) {
  // Must be a useRef, not a fresh object each render: the effect captures this
  // object once, so a new one per render would leave it holding a stale closure.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    if (takeInitialFocus) {
      const preferred = panel?.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
      (preferred ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (focusables.length === 0) {
        // Nothing tabbable inside yet (empty result list): keep focus on the panel
        // rather than letting Tab escape to the page behind.
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose is read via ref on purpose (see doc comment).
  }, [open, panelRef, takeInitialFocus]);
}
