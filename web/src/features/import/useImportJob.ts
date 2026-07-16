// Encapsulates the import-job poll lifecycle (GET /api/import/jobs/:id every
// 800ms until done|failed). `run(jobId)` resolves with the terminal job state
// so callers can chain sequential imports; `job` mirrors the live state for
// rendering a stepper. All timers are cancelled on unmount so no orphaned
// poll loop keeps calling setState after the component is gone.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ImportJob } from '../../lib/types';

const POLL_MS = 800;

export function useImportJob() {
  const [job, setJob] = useState<ImportJob | null>(null);
  const aliveRef = useRef(true);
  const cancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelRef.current();
    };
  }, []);

  const run = useCallback((jobId: string): Promise<ImportJob> => {
    cancelRef.current();
    return new Promise(resolve => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      cancelRef.current = () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
      };

      if (aliveRef.current) setJob({ id: jobId, status: 'queued' });

      const poll = async () => {
        if (cancelled) return;
        try {
          const latest = await api.importJob(jobId);
          if (cancelled) return;
          if (aliveRef.current) setJob(latest);
          if (latest.status === 'done' || latest.status === 'failed') {
            resolve(latest);
            return;
          }
          timer = setTimeout(poll, POLL_MS);
        } catch (err) {
          if (cancelled) return;
          const failed: ImportJob = {
            id: jobId,
            status: 'failed',
            error: err instanceof Error ? err.message : 'Lost connection while checking import status',
          };
          if (aliveRef.current) setJob(failed);
          resolve(failed);
        }
      };

      timer = setTimeout(poll, POLL_MS);
    });
  }, []);

  const reset = useCallback(() => {
    cancelRef.current();
    setJob(null);
  }, []);

  return { job, run, reset };
}
