// STUB — web-shell replaces this (keep the prop signature).
import type { ReactNode } from 'react';

export default function EmptyState({ icon, title, hint, action }: {
  icon: string; title: string; hint?: string; action?: ReactNode;
}) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--ink-2, #57606a)' }}>
      <div style={{ fontSize: 40 }}>{icon}</div>
      <div style={{ fontWeight: 600, marginTop: 8 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, marginTop: 4 }}>{hint}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
