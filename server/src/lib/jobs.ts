// In-memory import job store. Jobs are ephemeral — fine to lose on server restart,
// the client just re-imports. Auto-swept a while after they settle so a long-running
// dev server doesn't accumulate memory across many imports.

export type ImportJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  step?: string;
  noteId?: string;
  error?: string;
  attachmentId?: string;
}

const jobs = new Map<string, ImportJob>();
const SWEEP_AFTER_MS = 30 * 60_000; // 30 minutes after a job settles

function scheduleSweep(id: string): void {
  const t = setTimeout(() => jobs.delete(id), SWEEP_AFTER_MS);
  // Don't let this timer keep the process (or a test runner) alive.
  t.unref?.();
}

export function createJob(id: string, patch: Partial<Omit<ImportJob, 'id'>> = {}): ImportJob {
  const job: ImportJob = { id, status: 'queued', ...patch };
  jobs.set(id, job);
  return job;
}

export function updateJob(id: string, patch: Partial<Omit<ImportJob, 'id'>>): ImportJob | null {
  const existing = jobs.get(id);
  if (!existing) return null;
  const updated: ImportJob = { ...existing, ...patch };
  jobs.set(id, updated);
  if (updated.status === 'done' || updated.status === 'failed') scheduleSweep(id);
  return updated;
}

export function getJob(id: string): ImportJob | null {
  return jobs.get(id) ?? null;
}
