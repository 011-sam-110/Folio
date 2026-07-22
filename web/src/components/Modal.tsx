// web-shell - keep the prop signature exactly: { open, onClose, title?, width?, children }.
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

let titleSeq = 0;

export default function Modal({
  open,
  onClose,
  title,
  width,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: number;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  // Stable per-instance id so the visible title can NAME the dialog via
  // aria-labelledby rather than duplicating the string into aria-label.
  const titleId = useRef(`folio-modal-title-${++titleSeq}`).current;
  // Read onClose from a ref inside the handler so the trap effect can depend on [open]
  // ONLY. Callers pass a fresh onClose closure every render; depending on it here made the
  // effect tear down and re-run on every parent re-render, stealing focus back to the first
  // control (visible as ImportModal yanking focus once a second during its 800ms poll).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Consumers mark their intended first field with autoFocus. React applies that
    // during commit, but this passive effect runs afterwards, so focusing "the first
    // focusable" used to yank focus onto the header Close button and silently defeat
    // every consumer's autoFocus. Honour the marked element when there is one.
    const panel = panelRef.current;
    const preferred = panel?.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
    const toFocus = preferred ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (toFocus ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null,
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      lastFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="folio-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        className="folio-modal"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        // Point at the visible title where there is one, so the dialog's name and its
        // heading are the same node; fall back to a generic name for untitled dialogs
        // (aria-label={undefined} left those completely unnamed).
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : 'Dialog'}
        tabIndex={-1}
      >
        {title && (
          <div className="folio-modal__header">
            {/* A real heading: dialog content should start with one so screen-reader
                users can orient with heading navigation inside the dialog. */}
            <h2 className="folio-modal__title" id={titleId}>
              {title}
            </h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        <div className="folio-modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
