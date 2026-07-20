// Ink rendering. Everything about how a stroke actually LOOKS lives here.
//
// Three decisions drive the quality, and they are the three things naive web-ink
// implementations get wrong:
//
//  1. Curves, not segments. Raw pointer samples are ~8-16px apart during a fast
//     stroke; joining them with lineTo() gives visibly faceted, polygonal ink. We
//     trace a quadratic through the MIDPOINTS of consecutive samples, using each
//     sample as the control point. That is C1-continuous (no corners at joins),
//     costs one quadraticCurveTo per sample, and needs no lookahead — so the
//     live stroke can be drawn incrementally while the pen is still moving.
//
//  2. Pressure varies width, so it must be stroked per segment. A single Path2D
//     can only carry one lineWidth. Pen strokes therefore emit one short path per
//     sample with its own interpolated width; round caps and joins make the
//     abutting segments read as one continuous, tapering line.
//
//  3. Highlighter is the exact opposite and must be ONE path. Under
//     'multiply' blending, per-segment strokes overlap at every join and each
//     overlap darkens — a highlighter drawn that way comes out blotchy along its
//     own length. Constant width + a single stroke() means the stroke composites
//     against the page exactly once.

import type { InkPoint, InkStroke, InkTool } from '../../lib/types';
import { toScreen, type Point, type Viewport } from './geometry';

/** A sample as held in memory while drawing: world coords + pressure. */
export interface SamplePoint {
  x: number;
  y: number;
  p: number;
}

/** A stroke that has not been assigned a server id yet. `id` is a local temp id. */
export interface LocalStroke extends Omit<InkStroke, 'id'> {
  id: string;
  /** True until the POST /ink that carries it comes back with a real id. */
  pending?: boolean;
}

export const PEN_COLORS = ['#1f2328', '#4f46e5', '#d1242f', '#1a7f37', '#c2680a', '#7c3aed'] as const;
export const HIGHLIGHTER_COLORS = ['#ffe066', '#a5f3c4', '#a5d8ff', '#ffc9de', '#e2c6ff'] as const;

export const PEN_WIDTHS = [1.5, 3, 6, 10] as const;
export const HIGHLIGHTER_WIDTHS = [12, 20, 30] as const;

/** Radius (screen px) within which the eraser claims a stroke. */
export const ERASER_RADIUS = 12;

/**
 * Pressure -> width multiplier.
 *
 * Never returns 0: a pen reporting 0 pressure mid-stroke (which happens on the
 * first sample of some digitisers) would otherwise punch an invisible gap in the
 * middle of a line. The floor keeps the stroke continuous while still leaving
 * plenty of dynamic range for a genuine light touch.
 */
export function widthForPressure(base: number, pressure: number): number {
  const p = Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0.5;
  return base * (0.35 + 0.65 * p);
}

/**
 * Pressure to record for a pointer event.
 *
 * Mouse and most touchscreens report a constant 0.5 (or 0, or 1) — treating that
 * as real pressure would make mouse ink randomly thin. Only a pen's value is
 * trusted; everything else is pinned to the neutral midpoint so it renders at the
 * nominal width.
 */
export function pressureOf(e: { pointerType: string; pressure: number }): number {
  if (e.pointerType !== 'pen') return 0.5;
  // A pen that reports exactly 0 while down is reporting "unsupported", not "no
  // force" — the spec's default for a down pointer without pressure support.
  return e.pressure > 0 ? e.pressure : 0.5;
}

export function toSamples(points: readonly InkPoint[]): SamplePoint[] {
  return points.map(([x, y, p]) => ({ x, y, p }));
}

/** Round-trip to the wire format, trimmed to 2dp — a long stroke is thousands of
 *  points and full float precision roughly triples the payload for no visible gain. */
export function toInkPoints(samples: readonly SamplePoint[]): InkPoint[] {
  const r = (n: number) => Math.round(n * 100) / 100;
  return samples.map((s) => [r(s.x), r(s.y), Math.round(s.p * 1000) / 1000]);
}

const mid = (a: SamplePoint, b: SamplePoint): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Drop samples that are closer than `minDist` to the previously kept one.
 *
 * getCoalescedEvents() can hand back 60+ samples for a single frame of a fast
 * stroke, many of them sub-pixel apart. Keeping them all bloats the payload and
 * makes the per-segment pen path pathologically slow without changing a pixel.
 * The threshold is deliberately below one CSS pixel of *world* movement at 100%
 * zoom, so nothing visible is lost.
 */
export function decimate(samples: readonly SamplePoint[], minDist = 0.6): SamplePoint[] {
  if (samples.length <= 2) return [...samples];
  const out: SamplePoint[] = [samples[0]];
  const minSq = minDist * minDist;
  for (let i = 1; i < samples.length - 1; i++) {
    const last = out[out.length - 1];
    const dx = samples[i].x - last.x;
    const dy = samples[i].y - last.y;
    if (dx * dx + dy * dy >= minSq) out.push(samples[i]);
  }
  // The final sample is always kept: it is where the user lifted the pen, and
  // dropping it visibly shortens quick flicks.
  out.push(samples[samples.length - 1]);
  return out;
}

/** Trace the smoothed centreline of a whole stroke into the current path. */
function tracePath(ctx: CanvasRenderingContext2D, pts: readonly Point[]): void {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

/** A lone tap should leave a dot, not nothing. */
function drawDot(ctx: CanvasRenderingContext2D, p: Point, radius: number, color: string): void {
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(0.5, radius), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export interface DrawOptions {
  color: string;
  /** Nominal width in WORLD units — scaled by the viewport so ink zooms with the board. */
  width: number;
  tool: 'pen' | 'highlighter';
}

/**
 * Render one stroke. `samples` are in world coordinates; `vp` maps them to the
 * canvas's CSS-pixel space (the caller has already applied the DPR transform).
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  samples: readonly SamplePoint[],
  opts: DrawOptions,
  vp: Viewport,
): void {
  if (samples.length === 0) return;

  const pts = samples.map((s) => toScreen(s, vp));
  const screenWidth = opts.width * vp.scale;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = opts.color;

  if (opts.tool === 'highlighter') {
    // Multiply lets overlapping highlighter build up like real marker over text,
    // while a single stroke() stops the stroke building up against ITSELF.
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, screenWidth);
    if (pts.length === 1) {
      drawDot(ctx, pts[0], screenWidth / 2, opts.color);
    } else {
      ctx.beginPath();
      tracePath(ctx, pts);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // --- pen: per-segment width so pressure actually shows ---
  ctx.globalCompositeOperation = 'source-over';
  if (pts.length === 1) {
    drawDot(ctx, pts[0], widthForPressure(screenWidth, samples[0].p) / 2, opts.color);
    ctx.restore();
    return;
  }
  if (pts.length === 2) {
    ctx.beginPath();
    ctx.lineWidth = Math.max(0.4, widthForPressure(screenWidth, samples[1].p));
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  for (let i = 1; i < pts.length - 1; i++) {
    // Each segment spans midpoint(i-1,i) -> midpoint(i,i+1), curving through
    // sample i. Consecutive segments therefore share an endpoint exactly, and the
    // round cap at that shared point hides the width change between them.
    const start = i === 1 ? pts[0] : mid(samples[i - 1], samples[i]);
    const end = mid(samples[i], samples[i + 1]);
    ctx.beginPath();
    ctx.lineWidth = Math.max(0.4, widthForPressure(screenWidth, samples[i].p));
    ctx.moveTo(start.x, start.y);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, end.x, end.y);
    ctx.stroke();
  }
  // Close the run out to the final sample.
  const n = pts.length;
  ctx.beginPath();
  ctx.lineWidth = Math.max(0.4, widthForPressure(screenWidth, samples[n - 1].p));
  const tailStart = mid(samples[n - 2], samples[n - 1]);
  ctx.moveTo(tailStart.x, tailStart.y);
  ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
  ctx.stroke();

  ctx.restore();
}

/** Draw a whole layer. Highlighter goes down first so pen ink stays readable on
 *  top of it — the same order you would use with real pens on paper. */
export function drawLayer(ctx: CanvasRenderingContext2D, strokes: readonly LocalStroke[], vp: Viewport): void {
  const ordered = [...strokes].sort((a, b) => Number(a.tool === 'pen') - Number(b.tool === 'pen'));
  for (const s of ordered) {
    drawStroke(ctx, toSamples(s.points), { color: s.color, width: s.width, tool: s.tool }, vp);
  }
}

/**
 * Stroke ids the eraser should claim, given an eraser position in world space.
 * Stroke-level (not pixel-level) erase: simpler, undoable as one unit, and it
 * matches how the strokes are persisted (one row each).
 */
export function strokesNear(
  strokes: readonly LocalStroke[],
  at: Point,
  worldRadius: number,
): string[] {
  const hit: string[] = [];
  for (const s of strokes) {
    // Tolerance grows with the stroke's own width, so a fat highlighter is as easy
    // to catch as a hairline pen.
    const tol = worldRadius + s.width / 2;
    const tolSq = tol * tol;
    const pts = s.points;
    if (pts.length === 1) {
      const dx = pts[0][0] - at.x;
      const dy = pts[0][1] - at.y;
      if (dx * dx + dy * dy <= tolSq) hit.push(s.id);
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = { x: pts[i - 1][0], y: pts[i - 1][1] };
      const b = { x: pts[i][0], y: pts[i][1] };
      // Inlined rather than calling distToSegmentSq: this is the hot loop when
      // scrubbing the eraser across a page with hundreds of strokes.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq === 0 ? 0 : ((at.x - a.x) * dx + (at.y - a.y) * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = at.x - (a.x + t * dx);
      const ey = at.y - (a.y + t * dy);
      if (ex * ex + ey * ey <= tolSq) {
        hit.push(s.id);
        break;
      }
    }
  }
  return hit;
}

/** World-space bounding box of a stroke set — feeds "zoom to fit" on a board
 *  whose only content is ink. */
export function inkBounds(strokes: readonly LocalStroke[]): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const s of strokes) {
    for (const [x, y] of s.points) {
      any = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return any ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

export const defaultWidthFor = (tool: InkTool): number => (tool === 'highlighter' ? HIGHLIGHTER_WIDTHS[1] : PEN_WIDTHS[1]);
export const defaultColorFor = (tool: InkTool): string => (tool === 'highlighter' ? HIGHLIGHTER_COLORS[0] : PEN_COLORS[0]);
