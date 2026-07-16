// Small self-contained anchored dropdown used by the note action bar (AI ▾, Import ▾).
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface DropdownButtonProps {
  label: ReactNode;
  disabled?: boolean;
  align?: 'left' | 'right';
  children: (close: () => void) => ReactNode;
}

export default function DropdownButton({ label, disabled, align = 'left', children }: DropdownButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="folio-dropdown" ref={ref}>
      <button type="button" className="folio-btn" disabled={disabled} onClick={() => setOpen((v) => !v)}>
        {label} ▾
      </button>
      {open && <div className={`folio-dropdown-menu folio-dropdown-${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
