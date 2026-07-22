// Whisper model choices offered to the student.
//
// Sizes are the real measured download for the weight files this app actually requests
// (encoder + merged decoder), not the repo total.
//
// Speeds: the WASM figure for tiny is MEASURED in-browser (180s of real lecture audio
// transcribed in ~36s => 5x realtime, CPU only). base/small are scaled from that using the
// ratios observed locally with faster_whisper on the same audio (tiny 69s vs base 150s for a
// 53-minute lecture). The WebGPU figures are ESTIMATES — see the note below.
//
// WebGPU could not be verified here: the only available environment was headless, where the
// GPU path either hangs or fails inside onnxruntime. The code still prefers WebGPU when a
// real adapter is present and falls back to CPU on failure, but treat these numbers as
// unproven. They are deliberately conservative so the quoted time is a ceiling, not a hope.

export type WhisperSize = 'tiny' | 'base' | 'small';

export interface ModelChoice {
  size: WhisperSize;
  id: string;
  label: string;
  /** Download in MB, WebGPU (fp32) and WASM (q8) respectively. */
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
    downloadMb: { webgpu: 144, wasm: 39 },
    speed: { webgpu: 12, wasm: 5 },
    accuracy: 'Roughest',
    detail: 'Fastest and smallest. Gets the gist, but garbles technical terms and names.',
  },
  base: {
    size: 'base',
    id: 'onnx-community/whisper-base.en',
    label: 'Base',
    downloadMb: { webgpu: 278, wasm: 73 },
    speed: { webgpu: 7, wasm: 2.3 },
    accuracy: 'Balanced',
    detail: 'The sensible default. Noticeably better on jargon than Tiny, still practical.',
  },
  small: {
    size: 'small',
    id: 'onnx-community/whisper-small.en',
    label: 'Small',
    downloadMb: { webgpu: 923, wasm: 238 },
    speed: { webgpu: 2.5, wasm: 0.8 },
    accuracy: 'Best',
    detail: 'Clearly the most accurate, but a big download and slow without a GPU.',
  },
};

export const MODEL_ORDER: WhisperSize[] = ['tiny', 'base', 'small'];

/** Cheap synchronous check, good enough for a first estimate before anything is committed. */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Whether WebGPU can actually be used, which is not the same question as whether
 * `navigator.gpu` exists — the object is present in browsers that cannot hand out an
 * adapter (no supported GPU, blocklisted driver, headless/software rendering). Trusting
 * the property alone selects the GPU path and then runs it on a software fallback, which
 * measured far SLOWER than simply using WASM. Ask for the adapter instead.
 */
export async function detectWebGPU(): Promise<boolean> {
  if (!hasWebGPU()) return false;
  try {
    const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown | null> } }).gpu;
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
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
