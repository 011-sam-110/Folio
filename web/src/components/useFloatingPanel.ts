// web-shell internal helper - positions a floating panel against a trigger
// element with @floating-ui/dom and handles outside-click / Escape to close.
// Shared by EmojiPicker, ColorSwatches-style pickers, and other single-panel
// popovers. ContextMenu hand-rolls its own (it manages two stacked panels).
import { useEffect, useRef, useState } from 'react';
import { computePosition, offset, flip, shift, autoUpdate, type Placement } from '@floating-ui/dom';

export function useFloatingPanel<TRef extends HTMLElement = HTMLButtonElement, TPanel extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  opts: { placement?: Placement; offset?: number } = {},
) {
  const refEl = useRef<TRef | null>(null);
  const panelEl = useRef<TPanel | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const { placement = 'bottom-start', offset: gap = 6 } = opts;

  useEffect(() => {
    if (!open || !refEl.current || !panelEl.current) return;
    return autoUpdate(refEl.current, panelEl.current, () => {
      if (!refEl.current || !panelEl.current) return;
      computePosition(refEl.current, panelEl.current, {
        placement,
        middleware: [offset(gap), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => setPos({ x, y }));
    });
  }, [open, placement, gap]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (refEl.current?.contains(t) || panelEl.current?.contains(t)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return { refEl, panelEl, pos };
}
