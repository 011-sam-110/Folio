// The drawable surface. Owns pointer capture, palm rejection and the two canvases;
// knows nothing about boards, notes or persistence (that is useInkLayer's job).
//
// Two stacked canvases rather than one:
//   * `base`  holds every committed stroke and is redrawn only when the stroke
//             list or the viewport changes.
//   * `live`  holds the stroke currently under the pen and is cleared and redrawn
//             every frame.
// Redrawing hundreds of committed strokes on every pointermove is what makes
// naive implementations lag behind the pen; this keeps the per-frame cost
// proportional to the ONE stroke being drawn.

import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { InkTool } from '../../lib/types';
import { toWorld, type Viewport } from './geometry';
import {
  ERASER_RADIUS,
  decimate,
  drawLayer,
  drawStroke,
  pressureOf,
  strokesNear,
  toInkPoints,
  type LocalStroke,
  type SamplePoint,
} from './strokes';
import type { InkLayer } from './useInkLayer';

/**
 * How long after a pen event touch input stays ignored.
 *
 * THIS IS PALM REJECTION. An iPad user rests their hand on the glass while
 * writing, which the browser reports as ordinary `touch` pointers alongside the
 * pen's. Without this window every stroke would be accompanied by a fat smear
 * from the side of the hand, and the feature is unusable on the device it is
 * primarily for. One second comfortably covers the pen lifting between letters
 * while the palm never leaves the screen.
 */
const PEN_LOCKOUT_MS = 1000;

export interface InkSurfaceProps {
  layer: InkLayer;
  viewport: Viewport;
  /** When false the surface is inert and clicks pass through to what's beneath. */
  active: boolean;
  tool: InkTool;
  color: string;
  width: number;
  /** Let a finger draw when no stylus is around. Off by default — see InkToolbar. */
  fingerDraws: boolean;
  /** Committed a stroke / erased some, so the owner can push an undo entry. */
  onStrokeCommitted?: (stroke: LocalStroke) => void;
  onErased?: (removed: LocalStroke[]) => void;
  className?: string;
}

export default function InkSurface({
  layer,
  viewport,
  active,
  tool,
  color,
  width,
  fingerDraws,
  onStrokeCommitted,
  onErased,
  className,
}: InkSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef<HTMLCanvasElement | null>(null);

  // Everything touched inside a pointermove lives in a ref: re-rendering React
  // per sample would cap the stroke at React's throughput instead of the pen's.
  const samplesRef = useRef<SamplePoint[]>([]);
  const drawPointerRef = useRef<number | null>(null);
  const lastPenAtRef = useRef(0);
  const erasedRef = useRef<LocalStroke[]>([]);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const rafRef = useRef<number | null>(null);

  // Latest props for the pointer handlers, which are bound once per gesture.
  const cfgRef = useRef({ viewport, tool, color, width, fingerDraws, layer, onStrokeCommitted, onErased });
  cfgRef.current = { viewport, tool, color, width, fingerDraws, layer, onStrokeCommitted, onErased };

  /** Resize both canvases to their CSS box times the device pixel ratio, then
   *  scale the context so all drawing code can work in plain CSS pixels. Skipping
   *  this is what makes web ink look soft on a retina display. */
  const resize = useCallback(() => {
    const host = hostRef.current;
    if (!host) return false;
    const dpr = window.devicePixelRatio || 1;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return false;
    const prev = sizeRef.current;
    if (prev.w === w && prev.h === h && prev.dpr === dpr) return false;
    sizeRef.current = { w, h, dpr };
    for (const c of [baseRef.current, liveRef.current]) {
      if (!c) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    return true;
  }, []);

  const ctxOf = (c: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const { dpr } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  };

  const clearLive = useCallback(() => {
    const c = liveRef.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
    }
  }, []);

  const redrawBase = useCallback(() => {
    const c = baseRef.current;
    const ctx = ctxOf(c);
    if (!c || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
    drawLayer(ctx, layer.strokes, cfgRef.current.viewport);
  }, [layer.strokes]);

  // Redraw committed ink whenever the stroke list or the viewport moves. Clearing
  // the live canvas HERE (rather than at pointerup) means the just-finished stroke
  // is handed from one canvas to the other within a single paint — clearing it
  // earlier would flash a one-frame gap where the stroke vanishes.
  useLayoutEffect(() => {
    resize();
    redrawBase();
    clearLive();
  }, [resize, redrawBase, clearLive, viewport]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (resize()) {
        redrawBase();
        clearLive();
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [resize, redrawBase, clearLive]);

  /** Paint the in-progress stroke (and the eraser ring) onto the live canvas. */
  const paintLive = useCallback(() => {
    rafRef.current = null;
    const ctx = ctxOf(liveRef.current);
    const c = liveRef.current;
    if (!ctx || !c) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();

    const cfg = cfgRef.current;
    const samples = samplesRef.current;
    if (cfg.tool === 'eraser') {
      const last = samples[samples.length - 1];
      if (last) {
        const s = { x: last.x * cfg.viewport.scale + cfg.viewport.x, y: last.y * cfg.viewport.scale + cfg.viewport.y };
        ctx.beginPath();
        ctx.arc(s.x, s.y, ERASER_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(120,120,120,.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      return;
    }
    if (samples.length > 0) {
      drawStroke(ctx, samples, { color: cfg.color, width: cfg.width, tool: cfg.tool === 'highlighter' ? 'highlighter' : 'pen' }, cfg.viewport);
    }
  }, []);

  const scheduleLive = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(paintLive);
  }, [paintLive]);

  /**
   * Should this pointer draw?
   *
   * Pen always wins. Mouse draws on the primary button. Touch draws only when the
   * user has explicitly enabled it AND no pen has been seen recently — the second
   * clause is the palm rejection, and it applies even with finger-drawing on,
   * because a hand resting during pencil use is never intentional input.
   */
  const shouldDraw = useCallback((e: ReactPointerEvent<HTMLDivElement>): boolean => {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0;
    if (Date.now() - lastPenAtRef.current < PEN_LOCKOUT_MS) return false;
    return cfgRef.current.fingerDraws;
  }, []);

  const eraseAt = useCallback((world: { x: number; y: number }) => {
    const cfg = cfgRef.current;
    // The eraser's reach is a fixed number of SCREEN pixels, so it feels the same
    // size however far the board is zoomed out.
    const worldRadius = ERASER_RADIUS / cfg.viewport.scale;
    const hits = strokesNear(cfg.layer.strokes, world, worldRadius);
    if (hits.length === 0) return;
    erasedRef.current.push(...cfg.layer.removeStrokes(hits));
  }, []);

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'pen') lastPenAtRef.current = Date.now();
    if (!active) return;
    // One drawing pointer at a time: a second finger during a pen stroke must not
    // fork a second line.
    if (drawPointerRef.current !== null) return;
    if (!shouldDraw(e)) {
      // Deliberately no preventDefault/capture — the event keeps bubbling so the
      // board underneath can start a two-finger pan/pinch while ink is armed.
      return;
    }
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drawPointerRef.current = e.pointerId;

    const rect = e.currentTarget.getBoundingClientRect();
    const world = toWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, cfgRef.current.viewport);
    samplesRef.current = [{ x: world.x, y: world.y, p: pressureOf(e) }];
    erasedRef.current = [];
    if (cfgRef.current.tool === 'eraser') eraseAt(world);
    scheduleLive();
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    // Track the pen even when it is only hovering: newer iPads report hover, which
    // pre-arms palm rejection BEFORE the hand lands rather than after.
    if (e.pointerType === 'pen') lastPenAtRef.current = Date.now();
    if (drawPointerRef.current !== e.pointerId) return;
    e.preventDefault();

    const rect = e.currentTarget.getBoundingClientRect();
    const vp = cfgRef.current.viewport;

    // getCoalescedEvents() returns every sample the digitiser produced since the
    // last frame — typically 4-12 for a fast stroke, and up to 60+ on a 240Hz
    // pen. Reading only the delivered event throws all but the last away, which
    // is exactly what makes fast strokes come out as visible straight facets.
    const native = e.nativeEvent;
    const raw = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const events: Array<{ clientX: number; clientY: number; pressure: number; pointerType: string }> =
      raw.length > 0 ? raw : [native];

    for (const ev of events) {
      const world = toWorld({ x: ev.clientX - rect.left, y: ev.clientY - rect.top }, vp);
      samplesRef.current.push({ x: world.x, y: world.y, p: pressureOf(ev) });
      if (cfgRef.current.tool === 'eraser') eraseAt(world);
    }
    scheduleLive();
  }

  const finishStroke = useCallback(
    (pointerId: number) => {
      if (drawPointerRef.current !== pointerId) return;
      drawPointerRef.current = null;
      const cfg = cfgRef.current;
      const samples = samplesRef.current;
      samplesRef.current = [];

      if (cfg.tool === 'eraser') {
        const removed = erasedRef.current;
        erasedRef.current = [];
        if (removed.length > 0) cfg.onErased?.(removed);
        clearLive();
        return;
      }

      if (samples.length === 0) {
        clearLive();
        return;
      }
      const points = toInkPoints(decimate(samples));
      const committed = cfg.layer.addStroke({
        points,
        color: cfg.color,
        width: cfg.width,
        tool: cfg.tool === 'highlighter' ? 'highlighter' : 'pen',
      });
      cfg.onStrokeCommitted?.(committed);
      // Live canvas is NOT cleared here — the base redraw triggered by addStroke
      // clears it, so the stroke never blinks out between the two canvases.
    },
    [clearLive],
  );

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (drawPointerRef.current !== e.pointerId) return;
    e.preventDefault();
    finishStroke(e.pointerId);
  }

  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    // A cancel (OS gesture, pen leaving range) still commits what was drawn —
    // discarding it would silently eat a stroke the user watched appear.
    finishStroke(e.pointerId);
  }

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={`cv-ink${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      data-tool={active ? tool : undefined}
      // touch-action:none is mandatory. Without it the browser claims the gesture
      // and scrolls/zooms the page instead of delivering pointermove, and nothing
      // is ever drawn. It is set in CSS too; kept here so the rule cannot be lost
      // to a stylesheet edit.
      style={{ touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <canvas ref={baseRef} className="cv-ink__canvas" />
      <canvas ref={liveRef} className="cv-ink__canvas" />
    </div>
  );
}
