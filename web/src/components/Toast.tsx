// web-shell — keep the exported API: toast() + <Toaster/>.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

type Kind = 'ok' | 'error' | 'info';
interface ToastAction {
  label: string;
  onClick: () => void;
}
type Item = { id: number; message: string; kind: Kind; action?: ToastAction; durationMs: number };

let push: ((i: Item) => void) | null = null;
let nextId = 1;

export function toast(message: string, kind: Kind = 'info', opts: { action?: ToastAction; durationMs?: number } = {}) {
  push?.({ id: nextId++, message, kind, action: opts.action, durationMs: opts.durationMs ?? 4200 });
}

const ICONS: Record<Kind, React.ReactNode> = {
  ok: <Icon name="check" size={15} />,
  error: <Icon name="alert-circle" size={15} />,
  info: <Icon name="sparkles" size={14} />,
};

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    push = (i) => {
      setItems((prev) => [...prev, i]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== i.id)), i.durationMs);
    };
    return () => {
      push = null;
    };
  }, []);

  function dismiss(id: number) {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  return createPortal(
    <div
      className="folio-toaster"
      // Errors are the app's primary failure channel (~30 call sites) and were being
      // announced politely, i.e. often not at all before the toast auto-dismissed.
      aria-live={items.some((i) => i.kind === 'error') ? 'assertive' : 'polite'}
      // Per-toast, not per-stack: aria-atomic on the container re-announced every
      // visible toast each time a new one arrived.
      aria-atomic="false"
    >
      {items.map((i) => (
        // No role here: the container above is the live region. Nesting role="status"
        // inside an aria-live parent double-registers and some AT announces twice.
        <div key={i.id} className={`folio-toast ${i.kind}`}>
          <span className="folio-toast__icon">{ICONS[i.kind]}</span>
          <span className="folio-toast__msg">{i.message}</span>
          {i.action && (
            <button
              type="button"
              className="folio-toast__action"
              onClick={() => {
                dismiss(i.id);
                i.action!.onClick();
              }}
            >
              {i.action.label}
            </button>
          )}
          <button
            type="button"
            className="folio-toast__close"
            aria-label="Dismiss"
            onClick={() => dismiss(i.id)}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
