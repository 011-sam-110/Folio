/// <reference lib="webworker" />
// Whisper transcription worker.
//
// Everything here runs off the main thread: a 53-minute lecture is minutes of solid matrix
// maths, and on the main thread that is a frozen tab, not a slow one.
//
// transformers.js is imported DYNAMICALLY (inside the init handler, not at module scope) so it
// lands in its own lazily-fetched chunk. It is a very large dependency and no student who never
// imports a lecture should pay for it.
//
// Long audio is fed through in fixed batches rather than in one call. transformers.js can do its
// own long-form chunking, but a single call over 53 minutes is opaque: no progress until it
// finishes, and no way to stop. Batching gives an honest completion percentage, a real ETA, and
// a cancellation point every batch. Each batch still uses the pipeline's internal 30s
// chunk/stride windowing, so accuracy within a batch is unchanged.

import type { WhisperSize } from './models';

export interface TranscriptChunk {
  start: number;
  end: number;
  text: string;
}

export type WorkerRequest =
  | { type: 'init'; modelId: string; size: WhisperSize; device: 'webgpu' | 'wasm' }
  | { type: 'transcribe'; audio: Float32Array; sampleRate: number; batchSeconds: number; overlapSeconds: number }
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'download'; file: string; progress: number; loaded: number; total: number }
  | { type: 'ready'; device: string }
  | { type: 'progress'; processedSeconds: number; totalSeconds: number; chunks: TranscriptChunk[] }
  | { type: 'done'; chunks: TranscriptChunk[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }>;

let transcriber: Transcriber | null = null;
let cancelled = false;

const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);

async function init(modelId: string, device: 'webgpu' | 'wasm'): Promise<void> {
  // Dynamic: keeps transformers.js out of every other chunk in the app.
  const { pipeline, env } = await import('@huggingface/transformers');

  // Cache weights in the browser's Cache Storage so a second lecture import is instant
  // instead of re-downloading hundreds of megabytes.
  env.useBrowserCache = true;
  env.allowLocalModels = false;

  transcriber = (await pipeline('automatic-speech-recognition', modelId, {
    device,
    // fp16 is the WebGPU-friendly weight set; q8 keeps the WASM download and memory sane.
    dtype: device === 'webgpu' ? 'fp16' : 'q8',
    progress_callback: (p: unknown) => {
      const e = p as { status?: string; file?: string; progress?: number; loaded?: number; total?: number };
      if (e.status === 'progress' && e.file) {
        post({
          type: 'download',
          file: e.file,
          progress: e.progress ?? 0,
          loaded: e.loaded ?? 0,
          total: e.total ?? 0,
        });
      }
    },
  })) as unknown as Transcriber;

  post({ type: 'ready', device });
}

async function transcribe(
  audio: Float32Array,
  sampleRate: number,
  batchSeconds: number,
  overlapSeconds: number,
): Promise<void> {
  if (!transcriber) throw new Error('Model is not loaded');

  const totalSeconds = audio.length / sampleRate;
  const batchSamples = Math.max(1, Math.round(batchSeconds * sampleRate));
  const overlapSamples = Math.max(0, Math.round(overlapSeconds * sampleRate));

  const all: TranscriptChunk[] = [];
  let offsetSamples = 0;

  while (offsetSamples < audio.length) {
    if (cancelled) {
      post({ type: 'cancelled' });
      return;
    }

    // Each batch after the first starts slightly early so a sentence spanning the seam still
    // has its lead-in; the overlap region is discarded from the output below.
    const readStart = offsetSamples === 0 ? 0 : Math.max(0, offsetSamples - overlapSamples);
    const readEnd = Math.min(audio.length, offsetSamples + batchSamples);
    const slice = audio.subarray(readStart, readEnd);
    const sliceStartSeconds = readStart / sampleRate;
    const committedFrom = offsetSamples / sampleRate;

    const out = await transcriber(slice, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: 'en',
      task: 'transcribe',
    });

    const produced: TranscriptChunk[] = [];
    for (const c of out.chunks ?? []) {
      const text = c.text.trim();
      if (!text) continue;
      const start = sliceStartSeconds + (c.timestamp[0] ?? 0);
      // Whisper leaves the final chunk's end open when it runs to the edge of the audio.
      const end = sliceStartSeconds + (c.timestamp[1] ?? c.timestamp[0] ?? 0);
      // Drop anything already covered by the previous batch's committed range.
      if (start < committedFrom - 0.25) continue;
      produced.push({ start, end: Math.max(end, start), text });
    }
    all.push(...produced);

    offsetSamples = readEnd;
    post({
      type: 'progress',
      processedSeconds: Math.min(totalSeconds, offsetSamples / sampleRate),
      totalSeconds,
      chunks: produced,
    });
  }

  post({ type: 'done', chunks: all });
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  void (async () => {
    try {
      if (msg.type === 'cancel') {
        cancelled = true;
        return;
      }
      if (msg.type === 'init') {
        cancelled = false;
        await init(msg.modelId, msg.device);
        return;
      }
      if (msg.type === 'transcribe') {
        cancelled = false;
        await transcribe(msg.audio, msg.sampleRate, msg.batchSeconds, msg.overlapSeconds);
      }
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : 'Transcription failed' });
    }
  })();
});
