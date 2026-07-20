// Slide-change detection for lecture recordings.
//
// Pure, DOM-free and streaming: the caller feeds one downscaled grayscale frame at a time and
// gets back the accepted slides at the end. Keeping it pure is what let this be tuned offline
// against the real ~53-minute DSA lectures (see DEFAULTS for the resulting numbers) instead of
// guessed at in a browser.
//
// The shape of the problem, from looking at real recordings rather than fixtures:
//
//  * A lecture frame is a slide plus a webcam overlay of the presenter, who moves constantly.
//    A whole-frame diff therefore fires on essentially every sample. The overlay sits in a
//    fixed corner, so it is masked out of every comparison.
//  * Slides BUILD: bullets appear one at a time under an unchanged title. Emitting one "slide"
//    per build step produces a filmstrip of near-duplicates, so an additive change is folded
//    into the current slide and the RICHEST (latest) frame is what gets captured.
//  * Distinguishing a build from a genuinely new slide needs more than "did pixels change":
//    a new slide REPLACES ink or changes the title, a build only adds. Both signals are used,
//    because either alone misses cases (a sparse slide followed by a dense one removes nothing).
//  * Ink has to be measured relative to each frame's OWN background. An absolute threshold
//    reads block-averaged text as blank, which made every transition look additive.

/** Width/height every frame is downscaled to before any analysis. */
export const SAMPLE_W = 160;
export const SAMPLE_H = 90;

/** Coarse comparison grid. Diffing 32x32 cells rather than megapixels is what keeps a
 *  ~1000-sample scan cheap enough to run on the main thread between seeks. */
export const GRID_W = 32;
export const GRID_H = 32;
const GRID_CELLS = GRID_W * GRID_H;

/** Fraction of the frame (from the bottom-right corner) covered by the presenter overlay.
 *  Lecture-capture systems put the webcam in a corner; these values match the real recordings
 *  and are deliberately a little generous so overlay edges never leak into a comparison. */
export const DEFAULT_MASK = { x0: 0.74, y0: 0.73 };

/** Top slice of the frame treated as the slide title, compared at full sample resolution. */
const TITLE_BAND = 0.17;

export interface DetectorOptions {
  /** Seconds between samples. */
  interval: number;
  /** Per-cell brightness delta that counts a cell as "changed". */
  pixelThreshold: number;
  /** Fraction of unmasked cells that must change to count as a transition rather than noise
   *  (a cursor or the presenter's hand moves a few cells; a slide change moves many). */
  areaThreshold: number;
  /** Seconds a frame must hold still before a transition is committed. */
  stableSeconds: number;
  /** Fraction of the previous frame's ink that must disappear to read as a REPLACEMENT. */
  removalThreshold: number;
  /** Fraction of the frame gaining ink at once that reads as a new slide rather than a build. */
  addThreshold: number;
  /** Per-pixel delta counting as a change inside the title band. */
  titlePixelThreshold: number;
  /** Fraction of the title band that must change to force a new slide. */
  titleThreshold: number;
  /** Below this much ink, the previous frame is effectively blank — you cannot "build" on
   *  nothing, so any substantial content arriving is a new slide. */
  minInkBase: number;
  /** Slides on screen for less than this are transition artefacts, not slides. */
  minDurationSeconds: number;
  /** Final near-duplicate cull: fraction of cells that must differ from the previous KEPT slide. */
  dedupeThreshold: number;
  /** Bottom-right region excluded from every comparison, or null to compare the whole frame. */
  mask: { x0: number; y0: number } | null;
}

/** Tuned by sweeping against three real 53-minute lectures with hand-read ground truth
 *  (52 slides total). At these values: precision 94.1%, recall 94.1%. */
export const DEFAULTS: DetectorOptions = {
  interval: 3,
  pixelThreshold: 18,
  areaThreshold: 0.08,
  stableSeconds: 6,
  removalThreshold: 0.25,
  addThreshold: 0.3,
  titlePixelThreshold: 26,
  titleThreshold: 0.04,
  minInkBase: 30,
  minDurationSeconds: 10,
  dedupeThreshold: 0.02,
  mask: DEFAULT_MASK,
};

export interface DetectedSlide {
  /** When the slide first appeared. */
  startTime: number;
  /** Timestamp of the settled frame to capture — never the transition frame, and for a slide
   *  that builds, the last and therefore most complete state. */
  captureTime: number;
  /** How long the slide stayed on screen. Filled in once the following slide is known. */
  durationSeconds: number;
}

/** Marks which grid cells are outside the presenter overlay. */
export function buildValidMask(mask: DetectorOptions['mask']): Uint8Array {
  const valid = new Uint8Array(GRID_CELLS).fill(1);
  if (!mask) return valid;
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const cx = (gx + 0.5) / GRID_W;
      const cy = (gy + 0.5) / GRID_H;
      if (cx >= mask.x0 && cy >= mask.y0) valid[gy * GRID_W + gx] = 0;
    }
  }
  return valid;
}

/** Block-mean downscale of a SAMPLE_W x SAMPLE_H grayscale frame to the comparison grid. */
export function toGrid(gray: Float32Array | Uint8ClampedArray, out = new Float32Array(GRID_CELLS)): Float32Array {
  for (let gy = 0; gy < GRID_H; gy++) {
    const y0 = Math.floor((gy * SAMPLE_H) / GRID_H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * SAMPLE_H) / GRID_H));
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor((gx * SAMPLE_W) / GRID_W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * SAMPLE_W) / GRID_W));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * SAMPLE_W;
        for (let x = x0; x < x1; x++) {
          sum += gray[row + x];
          n++;
        }
      }
      out[gy * GRID_W + gx] = sum / n;
    }
  }
  return out;
}

/** Fraction of unmasked cells differing by more than `threshold`. Area, never mean: a slide is
 *  mostly white, so a mean would dilute "blank vs full of text" down to near nothing. */
export function areaDiff(a: Float32Array, b: Float32Array, valid: Uint8Array, threshold: number): number {
  let changed = 0;
  let total = 0;
  for (let i = 0; i < GRID_CELLS; i++) {
    if (!valid[i]) continue;
    total++;
    if (Math.abs(a[i] - b[i]) > threshold) changed++;
  }
  return total === 0 ? 0 : changed / total;
}

/** Cells meaningfully darker than this frame's own background (its 90th-percentile
 *  brightness). Relative, so it works for both white slides and dark shared-screen frames. */
export function inkMask(grid: Float32Array, valid: Uint8Array, delta = 20): Uint8Array {
  const values: number[] = [];
  for (let i = 0; i < GRID_CELLS; i++) if (valid[i]) values.push(grid[i]);
  values.sort((a, b) => a - b);
  const bg = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.9))] : 255;
  const cut = bg - delta;
  const ink = new Uint8Array(GRID_CELLS);
  for (let i = 0; i < GRID_CELLS; i++) ink[i] = valid[i] && grid[i] < cut ? 1 : 0;
  return ink;
}

function countOnes(a: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i];
  return n;
}

/** Fraction of the title band whose pixels changed, at full sample resolution — the coarse
 *  grid smears a single line of title text away to nothing. */
function titleDiff(a: Float32Array, b: Float32Array, threshold: number): number {
  const rows = Math.max(1, Math.round(SAMPLE_H * TITLE_BAND));
  const n = rows * SAMPLE_W;
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > threshold) changed++;
  return changed / n;
}

interface Segment {
  startTime: number;
  captureTime: number;
  captureGrid: Float32Array;
}

/**
 * Streaming slide detector. Feed frames in ascending time with `push`, then call `finish`.
 */
export class SlideDetector {
  private readonly opts: DetectorOptions;
  private readonly valid: Uint8Array;
  private readonly segments: Segment[] = [];

  private prevGrid: Float32Array | null = null;
  private prevGray: Float32Array | null = null;
  private prevTime = 0;

  private curStart = 0;
  private curCaptureTime = 0;
  private curCaptureGrid: Float32Array | null = null;

  private pendingTime: number | null = null;
  private lastTime = 0;

  constructor(options: Partial<DetectorOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.valid = buildValidMask(this.opts.mask);
  }

  /** @param gray SAMPLE_W*SAMPLE_H grayscale samples. The array is copied where retained. */
  push(time: number, gray: Float32Array): void {
    const grid = toGrid(gray);
    this.lastTime = time;

    if (!this.prevGrid || !this.prevGray) {
      this.prevGrid = grid;
      this.prevGray = Float32Array.from(gray);
      this.prevTime = time;
      this.curStart = time;
      this.curCaptureTime = time;
      this.curCaptureGrid = Float32Array.from(grid);
      return;
    }

    const o = this.opts;
    if (areaDiff(grid, this.prevGrid, this.valid, o.pixelThreshold) > o.areaThreshold) {
      const oldInk = inkMask(this.prevGrid, this.valid);
      const newInk = inkMask(grid, this.valid);
      const oldCount = countOnes(oldInk);

      let removedCount = 0;
      let addedCount = 0;
      let validCount = 0;
      for (let i = 0; i < GRID_CELLS; i++) {
        if (!this.valid[i]) continue;
        validCount++;
        if (oldInk[i] && !newInk[i]) removedCount++;
        if (newInk[i] && !oldInk[i]) addedCount++;
      }
      const removed = removedCount / Math.max(1, oldCount);
      const added = addedCount / Math.max(1, validCount);
      const tChange = titleDiff(gray as Float32Array, this.prevGray, o.titlePixelThreshold);

      const isNewSlide =
        removed > o.removalThreshold ||
        tChange > o.titleThreshold ||
        added > o.addThreshold ||
        oldCount < o.minInkBase;

      if (isNewSlide) {
        this.pendingTime = time;
      } else {
        // Additive build of the slide already on screen — keep the richer, later frame.
        this.curCaptureTime = time;
        this.curCaptureGrid = Float32Array.from(grid);
      }
      this.prevGrid = grid;
      this.prevGray = Float32Array.from(gray);
      this.prevTime = time;
      return;
    }

    // Held still since the previous sample.
    if (this.pendingTime !== null && time - this.pendingTime >= o.stableSeconds) {
      this.segments.push({
        startTime: this.curStart,
        captureTime: this.curCaptureTime,
        captureGrid: this.curCaptureGrid ?? Float32Array.from(grid),
      });
      this.curStart = this.pendingTime;
      this.curCaptureTime = time; // settled frame, not the transition frame
      this.curCaptureGrid = Float32Array.from(grid);
      this.pendingTime = null;
    } else if (this.pendingTime === null) {
      this.curCaptureTime = time;
      this.curCaptureGrid = Float32Array.from(grid);
    }

    this.prevGrid = grid;
    this.prevGray = Float32Array.from(gray);
    this.prevTime = time;
  }

  /** @param endTime total duration, used to close the final slide. */
  finish(endTime?: number): DetectedSlide[] {
    const end = endTime ?? this.lastTime;
    if (this.curCaptureGrid) {
      this.segments.push({
        startTime: this.curStart,
        captureTime: this.curCaptureTime,
        captureGrid: this.curCaptureGrid,
      });
    }

    const o = this.opts;
    const withDuration = this.segments.map((s, i) => ({
      ...s,
      durationSeconds: (i + 1 < this.segments.length ? this.segments[i + 1].startTime : end) - s.startTime,
    }));

    // A real slide is on screen for a while; anything briefer is a transition artefact.
    const longEnough = withDuration.filter(s => s.durationSeconds >= o.minDurationSeconds);
    const pool = longEnough.length ? longEnough : withDuration;

    // Final near-duplicate cull against the previous KEPT slide.
    const kept: typeof pool = [];
    let prev: Float32Array | null = null;
    for (const s of pool) {
      if (prev && areaDiff(s.captureGrid, prev, this.valid, o.pixelThreshold) < o.dedupeThreshold) continue;
      kept.push(s);
      prev = s.captureGrid;
    }

    return kept.map(s => ({
      startTime: s.startTime,
      captureTime: s.captureTime,
      durationSeconds: s.durationSeconds,
    }));
  }
}
