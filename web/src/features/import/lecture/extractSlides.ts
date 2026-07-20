// Browser-side slide extraction from a lecture video.
//
// The video file NEVER leaves the machine and is never read into memory as bytes: it is handed
// to a <video> element as an object URL, and the element streams/decodes it. A 150MB lecture
// costs a blob URL and whatever the decoder buffers, not 150MB of JS heap. Only the handful of
// derived JPEGs ever reach the network.
//
// Two passes, because they want different things:
//   1. SCAN  — seek every few seconds, draw into a tiny 160x90 canvas and diff. Cheap, and the
//              only pass that touches most of the timeline.
//   2. CAPTURE — re-seek to just the ~20 accepted timestamps and draw those at full resolution.
// Doing it this way means full-size frames are only ever decoded for frames actually kept,
// instead of holding a thousand full-resolution bitmaps to throw nearly all of them away.

import { SlideDetector, DEFAULTS, SAMPLE_W, SAMPLE_H, type DetectorOptions, type DetectedSlide } from './detector';

export interface SlideImage {
  /** Timestamp of the captured frame, in seconds. */
  time: number;
  /** When this slide first appeared. */
  startTime: number;
  /** How long it was on screen. */
  durationSeconds: number;
  blob: Blob;
  /** Object URL for previewing. The caller owns revoking it. */
  url: string;
  width: number;
  height: number;
}

export interface ExtractProgress {
  phase: 'scanning' | 'capturing';
  /** 0..1 */
  progress: number;
  /** Slides found so far. */
  found: number;
  currentTime: number;
  duration: number;
}

export interface ExtractOptions extends Partial<DetectorOptions> {
  /** Longest edge of the captured slide images. */
  maxCaptureWidth?: number;
  /** JPEG quality for captured slides. */
  quality?: number;
  signal?: AbortSignal;
  onProgress?: (p: ExtractProgress) => void;
}

class AbortedError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/** Loads a File into a <video> and resolves once its duration and dimensions are known. */
export function loadVideo(file: File): Promise<{ video: HTMLVideoElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    // Not attached to the document: it only ever needs to decode frames for canvas draws.
    video.style.position = 'fixed';
    video.style.left = '-10000px';

    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
    };
    const onMeta = () => {
      cleanup();
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read the video duration — the file may be corrupt or use an unsupported codec.'));
        return;
      }
      resolve({ video, url });
    };
    const onError = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error("This video couldn't be opened. Your browser may not support its codec — try an MP4 (H.264)."));
    };

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onError);
    video.src = url;
  });
}

/** Seeks and resolves when the frame at that time is actually available to draw. */
function seekTo(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
      fn();
    };
    const onSeeked = () => done(resolve);
    const onError = () => done(() => reject(new Error('Video seek failed')));
    // A seek that never completes (some codecs near the tail) must not hang the whole import.
    const timer = setTimeout(() => done(resolve), 5000);

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    if (signal?.aborted) {
      done(() => reject(new AbortedError()));
      return;
    }
    video.currentTime = Math.min(time, Math.max(0, video.duration - 0.05));
  });
}

/** Draws the current frame into the small analysis canvas and returns it as grayscale. */
function readGrayFrame(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  out: Float32Array,
): Float32Array {
  ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
  const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Rec. 601 luma — matches what the offline tuning used (ffmpeg's `format=gray`).
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return out;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the slide image'))), type, quality);
  });
}

/**
 * Scans a lecture video and returns one compressed image per detected slide.
 */
export async function extractSlides(file: File, options: ExtractOptions = {}): Promise<SlideImage[]> {
  const {
    maxCaptureWidth = 1280,
    quality = 0.72,
    signal,
    onProgress,
    ...detectorOptions
  } = options;

  const interval = detectorOptions.interval ?? DEFAULTS.interval;
  const { video, url } = await loadVideo(file);
  const duration = video.duration;

  const scanCanvas = document.createElement('canvas');
  scanCanvas.width = SAMPLE_W;
  scanCanvas.height = SAMPLE_H;
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
  if (!scanCtx) {
    URL.revokeObjectURL(url);
    throw new Error('Could not create a canvas to read video frames');
  }

  const detector = new SlideDetector(detectorOptions);
  const gray = new Float32Array(SAMPLE_W * SAMPLE_H);

  try {
    // ---- Pass 1: scan ----
    for (let t = 0; t < duration; t += interval) {
      throwIfAborted(signal);
      await seekTo(video, t, signal);
      detector.push(t, readGrayFrame(video, scanCtx, gray));
      onProgress?.({
        phase: 'scanning',
        progress: Math.min(1, t / duration),
        found: 0,
        currentTime: t,
        duration,
      });
      // Yield so the UI can paint and the cancel button stays responsive.
      await new Promise(r => setTimeout(r, 0));
    }

    const detected: DetectedSlide[] = detector.finish(duration);

    // ---- Pass 2: capture only what survived ----
    const scale = Math.min(1, maxCaptureWidth / (video.videoWidth || maxCaptureWidth));
    const outW = Math.max(1, Math.round((video.videoWidth || maxCaptureWidth) * scale));
    const outH = Math.max(1, Math.round((video.videoHeight || 720) * scale));
    const shotCanvas = document.createElement('canvas');
    shotCanvas.width = outW;
    shotCanvas.height = outH;
    const shotCtx = shotCanvas.getContext('2d');
    if (!shotCtx) throw new Error('Could not create a canvas to capture slides');

    const slides: SlideImage[] = [];
    for (let i = 0; i < detected.length; i++) {
      throwIfAborted(signal);
      const d = detected[i];
      await seekTo(video, d.captureTime, signal);
      shotCtx.drawImage(video, 0, 0, outW, outH);
      const blob = await canvasToBlob(shotCanvas, 'image/jpeg', quality);
      slides.push({
        time: d.captureTime,
        startTime: d.startTime,
        durationSeconds: d.durationSeconds,
        blob,
        url: URL.createObjectURL(blob),
        width: outW,
        height: outH,
      });
      onProgress?.({
        phase: 'capturing',
        progress: (i + 1) / Math.max(1, detected.length),
        found: slides.length,
        currentTime: d.captureTime,
        duration,
      });
    }
    return slides;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
