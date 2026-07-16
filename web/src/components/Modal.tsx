// STUB — web-shell replaces this (keep the prop signature).
import type { ReactNode } from 'react';

export default function Modal({ open, onClose, title, width, children }: {
  open: boolean; onClose: () => void; title?: string; width?: number; children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', display: 'grid', placeItems: 'center', zIndex: 100 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg, #fff)', borderRadius: 12, padding: 20, width: width ?? 480, maxWidth: '92vw', maxHeight: '85vh', overflow: 'auto' }}>
        {title && <h3 style={{ marginTop: 0 }}>{title}</h3>}
        {children}
      </div>
    </div>
  );
}
