// Drives the Whisper worker and turns its messages into progress a student can trust:
// a real percentage of audio processed, elapsed time, and an ETA extrapolated from the rate
// actually observed so far rather than from an optimistic constant.

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODELS, type WhisperSize, detectWebGPU } from './models';
import type { TranscriptChunk, WorkerRequest, WorkerResponse } from './transcribeWorker';

export type TranscribePhase = 'idle' | 'loading-model' | 'transcribing' | 'done' | 'error' | 'cancelled';

export interface TranscribeState {
  phase: TranscribePhase;
  /** 0..1 across the audio. */
  progress: number;
  processedSeconds: number;
  totalSeconds: number;
  elapsedSeconds: number;
  /** Null until enough has been processed to extrapolate honestly. */
  etaSeconds: number | null;
  /** 0..1 while weights download. */
  downloadProgress: number;
  downloadLabel: string;
  chunks: TranscriptChunk[];
  error: string | null;
  device: 'webgpu' | 'wasm';
}

const INITIAL: TranscribeState = {
  phase: 'idle',
  progress: 0,
  processedSeconds: 0,
  totalSeconds: 0,
  elapsedSeconds: 0,
  etaSeconds: null,
  downloadProgress: 0,
  downloadLabel: '',
  chunks: [],
  error: null,
  device: 'wasm',
};

export function useTranscription() {
  const [state, setState] = useState<TranscribeState>(INITIAL);
  const workerRef = useRef<Worker | null>(null);
  const startedAtRef = useRef(0);
  const resolveRef = useRef<((chunks: TranscriptChunk[]) => void) | null>(null);
  const rejectRef = useRef<((err: Error) => void) | null>(null);

  const terminate = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => () => terminate(), [terminate]);

  // Elapsed time ticks independently of worker messages, which arrive only once per batch.
  useEffect(() => {
    if (state.phase !== 'transcribing' && state.phase !== 'loading-model') return;
    const id = window.setInterval(() => {
      setState(s => ({ ...s, elapsedSeconds: (Date.now() - startedAtRef.current) / 1000 }));
    }, 500);
    return () => window.clearInterval(id);
  }, [state.phase]);

  const cancel = useCallback(() => {
    workerRef.current?.postMessage({ type: 'cancel' } satisfies WorkerRequest);
    terminate();
    setState(s => ({ ...s, phase: 'cancelled' }));
    rejectRef.current?.(new DOMException('Cancelled', 'AbortError'));
    resolveRef.current = null;
    rejectRef.current = null;
  }, [terminate]);

  const run = useCallback(
    async (audio: Float32Array, sampleRate: number, size: WhisperSize): Promise<TranscriptChunk[]> => {
      terminate();
      // Confirmed by actually requesting an adapter, not by sniffing navigator.gpu.
      const device: 'webgpu' | 'wasm' = (await detectWebGPU()) ? 'webgpu' : 'wasm';
      startedAtRef.current = Date.now();
      setState({
        ...INITIAL,
        phase: 'loading-model',
        totalSeconds: audio.length / sampleRate,
        device,
      });

      return new Promise<TranscriptChunk[]>((resolve, reject) => {
        resolveRef.current = resolve;
        rejectRef.current = reject;

        const worker = new Worker(new URL('./transcribeWorker.ts', import.meta.url), { type: 'module' });
        workerRef.current = worker;

        worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
          const msg = event.data;
          if (msg.type === 'download') {
            setState(s => ({
              ...s,
              downloadProgress: Math.max(s.downloadProgress, (msg.progress ?? 0) / 100),
              downloadLabel: msg.file,
            }));
            return;
          }
          if (msg.type === 'ready') {
            setState(s => ({ ...s, phase: 'transcribing', downloadProgress: 1, device: msg.device as 'webgpu' | 'wasm' }));
            const payload = {
              type: 'transcribe',
              audio,
              sampleRate,
              batchSeconds: 120,
              overlapSeconds: 2,
            } satisfies WorkerRequest;
            try {
              // Transferring hands the buffer over rather than structured-cloning ~200MB.
              // It is not always allowed: `getChannelData()` can hand back a view whose buffer
              // the AudioBuffer still owns, and transferring that throws. Falling back to a
              // structured clone costs a copy but is far better than the alternative — the
              // throw used to escape this listener, leaving the promise forever pending and
              // the UI parked on "Transcribing…" with nothing running.
              worker.postMessage(payload, [audio.buffer as ArrayBuffer]);
            } catch {
              worker.postMessage(payload);
            }
            return;
          }
          if (msg.type === 'progress') {
            setState(s => {
              const elapsed = (Date.now() - startedAtRef.current) / 1000;
              const ratio = msg.totalSeconds > 0 ? msg.processedSeconds / msg.totalSeconds : 0;
              // Extrapolate from the observed rate, and only once there is enough to be
              // meaningful — an ETA from the first few seconds is a guess dressed as a fact.
              const eta = ratio > 0.02 ? (elapsed / ratio) * (1 - ratio) : null;
              return {
                ...s,
                phase: 'transcribing',
                progress: ratio,
                processedSeconds: msg.processedSeconds,
                totalSeconds: msg.totalSeconds,
                elapsedSeconds: elapsed,
                etaSeconds: eta,
                chunks: [...s.chunks, ...msg.chunks],
              };
            });
            return;
          }
          if (msg.type === 'done') {
            setState(s => ({ ...s, phase: 'done', progress: 1, etaSeconds: 0, chunks: msg.chunks }));
            resolveRef.current?.(msg.chunks);
            resolveRef.current = null;
            rejectRef.current = null;
            terminate();
            return;
          }
          if (msg.type === 'cancelled') {
            setState(s => ({ ...s, phase: 'cancelled' }));
            terminate();
            return;
          }
          setState(s => ({ ...s, phase: 'error', error: msg.message }));
          rejectRef.current?.(new Error(msg.message));
          resolveRef.current = null;
          rejectRef.current = null;
          terminate();
        });

        worker.addEventListener('error', e => {
          const message = e.message || 'The transcription worker failed to start';
          setState(s => ({ ...s, phase: 'error', error: message }));
          rejectRef.current?.(new Error(message));
          resolveRef.current = null;
          rejectRef.current = null;
          terminate();
        });

        worker.postMessage({
          type: 'init',
          modelId: MODELS[size].id,
          size,
          device,
        } satisfies WorkerRequest);
      });
    },
    [terminate],
  );

  const reset = useCallback(() => {
    terminate();
    setState(INITIAL);
  }, [terminate]);

  return { state, run, cancel, reset };
}
