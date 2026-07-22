// web-shell - keep the prop signature exactly: { icon, title, hint?, action? }.
import type { ReactNode } from 'react';

export default function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="folio-empty">
      <div className="folio-empty__icon" aria-hidden="true">{icon}</div>
      <div className="folio-empty__title">{title}</div>
      {hint && <div className="folio-empty__hint">{hint}</div>}
      {action && <div className="folio-empty__action">{action}</div>}
    </div>
  );
}
