// Whisper model choices offered to the student.
//
// Sizes are the real measured download for the weight files this app actually requests
// (encoder + merged decoder), not the repo total. Speeds are anchored to a measured
// local baseline: faster_whisper on this machine's CPU ran a 53-minute lecture in 69s
// with tiny and 150s with base. In-browser ONNX is several times slower than that, which
// is why the estimates below are deliberately conservative rather than flattering.

export type WhisperSize = 'tiny' | 'base' | 'small';

export interface ModelChoice {
  size: WhisperSize;
  id: string;
  label: string;
  /** Download in MB, WebGPU (fp16) and WASM (q8) respectively. */
  downloadMb: { webgpu: number; wasm: number };
  /** Rough multiple of realtime, i.e. 6 means a 60-minute lecture takes ~10 minutes. */
  speed: { webgpu: number; wasm: number };
  accuracy: string;
  detail: string;
}

export const MODELS: Record<WhisperSize, ModelChoice> = {
  tiny: {
    size: 'tiny',
    id: 'onnx-community/whisper-tiny.en',
    label: 'Tiny',
    downloadMb: { webgpu: 73, wasm: 39 },
    speed: { webgpu: 12, wasm: 4 },
    accuracy: 'Roughest',
    detail: 'Fastest and smallest. Gets the gist, but garbles technical terms and names.',
  },
  base: {
    size: 'base',
    id: 'onnx-community/whisper-base.en',
    label: 'Base',
    downloadMb: { webgpu: 139, wasm: 73 },
    speed: { webgpu: 7, wasm: 2.2 },
    accuracy: 'Balanced',
    detail: 'The sensible default — noticeably better on jargon than Tiny, still practical.',
  },
  small: {
    size: 'small',
    id: 'onnx-community/whisper-small.en',
    label: 'Small',
    downloadMb: { webgpu: 463, wasm: 238 },
    speed: { webgpu: 2.5, wasm: 0.8 },
    accuracy: 'Best',
    detail: 'Clearly the most accurate, but a big download and slow without a GPU.',
  },
};

export const MODEL_ORDER: WhisperSize[] = ['tiny', 'base', 'small'];

/** WebGPU is several times faster than the WASM fallback, so it changes every estimate. */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Predicted wall-clock transcription time, used for the up-front warning. */
export function estimateTranscribeSeconds(model: ModelChoice, audioSeconds: number, webgpu: boolean): number {
  return audioSeconds / (webgpu ? model.speed.webgpu : model.speed.wasm);
}
