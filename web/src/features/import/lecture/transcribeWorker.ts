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
/** Kept so the WebGPU path can be rebuilt on the CPU backend if it turns out not to work. */
let currentDevice: 'webgpu' | 'wasm' = 'wasm';
let currentModelId = '';
let buildPipeline: ((device: 'webgpu' | 'wasm') => Promise<Transcriber>) | null = null;

const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);

async function init(modelId: string, device: 'webgpu' | 'wasm'): Promise<void> {
  // Dynamic: keeps transformers.js out of every other chunk in the app.
  const { pipeline, env } = await import('@huggingface/transformers');

  // Cache weights in the browser's Cache Storage so a second lecture import is instant
  // instead of re-downloading hundreds of megabytes.
  env.useBrowserCache = true;
  env.allowLocalModels = false;

  const progress_callback = (p: unknown) => {
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
  };

  const build = (d: 'webgpu' | 'wasm') =>
    pipeline('automatic-speech-recognition', modelId, {
      device: d,
      // fp32 on the GPU, q8 on the CPU. fp16 was tried first and is NOT safe here: the
      // pipeline builds, then the very first inference dies inside onnxruntime with
      // "Missing required scale ... TransposeDQWeightsForMatMulNBits". q8 also keeps the
      // WASM download and memory footprint sane.
      dtype: d === 'webgpu' ? 'fp32' : 'q8',
      progress_callback,
    }) as unknown as Promise<Transcriber>;

  buildPipeline = build;
  currentModelId = modelId;

  let used = device;
  try {
    transcriber = await build(device);
  } catch (err) {
    // An adapter can be advertised and still fail to build a working session (driver
    // blocklists, exhausted GPU memory). Falling back beats failing the whole import.
    if (device !== 'webgpu') throw err;
    used = 'wasm';
    transcriber = await build('wasm');
  }

  currentDevice = used;
  post({ type: 'ready', device: used });
}

/**
 * Runs one batch, falling back from GPU to CPU if the GPU backend fails.
 *
 * The fallback has to live here and not only around pipeline construction: onnxruntime
 * creates its sessions lazily, so a broken GPU configuration builds cleanly and only throws
 * on the FIRST inference. Catching it at build time alone let that failure reach the user.
 */
async function runBatch(slice: Float32Array, options: Record<string, unknown>) {
  if (!transcriber) throw new Error('Model is not loaded');
  try {
    return await transcriber(slice, options);
  } catch (err) {
    if (currentDevice !== 'webgpu' || !buildPipeline) throw err;
    console.warn(`[folio] WebGPU transcription failed for ${currentModelId}; retrying on CPU`, err);
    transcriber = await buildPipeline('wasm');
    currentDevice = 'wasm';
    post({ type: 'ready', device: 'wasm' });
    return await transcriber(slice, options);
  }
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

  // Emitted before any work so the UI shows 0% the moment the audio lands, rather than
  // sitting blank until the first batch returns two minutes later.
  post({ type: 'progress', processedSeconds: 0, totalSeconds, chunks: [] });

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

    // No `language`/`task` here: every model offered is an English-only (.en) checkpoint, and
    // those reject both options outright ("Cannot specify `task` or `language` for an
    // English-only model"). Passing them defensively fails the entire import.
    const out = await runBatch(slice, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
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
