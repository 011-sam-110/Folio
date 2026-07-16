// Shared stepper UI for an in-flight import job — used by both ImportModal
// (desktop) and CapturePage (mobile, via `compact`).
import type { ImportJob } from '../../lib/types';
import './ImportProgress.css';

const STATUS_LABEL: Record<ImportJob['status'], string> = {
  queued: 'Queued…',
  running: 'Processing…',
  done: 'Done',
  failed: 'Failed',
};

export default function ImportProgress({ job, pageInfo, compact }: {
  job: ImportJob | null;
  pageInfo?: { index: number; total: number };
  compact?: boolean;
}) {
  const label = job ? (job.step ?? STATUS_LABEL[job.status]) : 'Starting…';
  const active = !job || job.status === 'queued' || job.status === 'running';

  return (
    <div className={`im-progress${compact ? ' im-progress--compact' : ''}`} role="status" aria-live="polite">
      {pageInfo && pageInfo.total > 1 && (
        <div className="im-progress__page">Page {pageInfo.index + 1} of {pageInfo.total}</div>
      )}
      <div className="im-progress__track">
        <div className={`im-progress__bar${active ? ' is-active' : ''}`} />
      </div>
      <div className="im-progress__label">
        {active && <span className="im-progress__dot" aria-hidden="true" />}
        {label}
      </div>
    </div>
  );
}
