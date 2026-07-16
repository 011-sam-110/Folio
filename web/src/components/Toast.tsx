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
    <div className="folio-toaster" aria-live="polite" aria-atomic="true">
      {items.map((i) => (
        <div key={i.id} className={`folio-toast ${i.kind}`} role="status">
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
