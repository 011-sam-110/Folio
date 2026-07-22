import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

export interface DialogFocusOptions {
  /**
   * Trap Tab inside the panel and lock body scroll. True for modal overlays
   * (palettes, dialogs); false for the side drawers, which are deliberately
   * non-modal - the note stays readable and editable behind them.
   */
  trap?: boolean;
  /** Pass false when the panel focuses its own field (e.g. a search input). */
  takeInitialFocus?: boolean;
}

/**
 * Dialog/drawer focus behaviour for overlays that don't use `Modal`.
 *
 * Two bugs this exists to fix, both found by keyboard-only walkthrough:
 *
 * 1. The palette overlays (CommandPalette, QuickSwitcher) declared
 *    `role="dialog" aria-modal="true"` but implemented none of it - Tab walked
 *    straight into the page behind (13 of 14 stops leaked), and Escape was a React
 *    `onKeyDown` on the panel, so it stopped working the instant focus left.
 *
 * 2. The side drawers (HistoryPanel, AssistantPanel, CommentsPanel) put `onKeyDown`
 *    on the panel but never moved focus into it, so Escape was dead on arrival:
 *    focus was still on the trigger button outside the panel when it opened.
 *
 * Escape is therefore handled on the document in the capture phase - it works
 * wherever focus currently is - and focus is always restored to the trigger.
 *
 * `onClose` is read through a ref, so callers may pass a fresh closure each render
 * without the effect tearing down and stealing focus back mid-interaction.
 */
export function useDialogFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  { trap = true, takeInitialFocus = true }: DialogFocusOptions = {},
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
    if (trap) document.body.style.overflow = 'hidden';

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
      if (!trap || e.key !== 'Tab' || !panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (focusables.length === 0) {
        // Nothing tabbable inside yet (an empty result list): hold focus on the
        // panel rather than letting Tab escape to the page behind.
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
      if (trap) document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, panelRef, trap, takeInitialFocus]);
}
