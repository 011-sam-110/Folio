// Pan and zoom for the infinite board.
//
// Input mapping follows the convention every spatial tool shares (Figma, Miro,
// Freeform), because a canvas that invents its own is immediately frustrating:
//   * plain wheel / two-finger trackpad drag  -> pan
//   * ctrl/cmd + wheel                        -> zoom about the cursor
//   * trackpad pinch                          -> the browser already reports this
//                                                as ctrl+wheel, so it falls out
//                                                of the rule above for free
//   * two-finger touch                        -> pinch to zoom + drag to pan
//   * space-drag, middle-drag                 -> pan

import { useCallback, useEffect, useRef, useState } from 'react';
import { clampScale, fitViewport, zoomAt, type Rect, type Viewport } from './geometry';

/** Trackpads report fractional deltas; a mouse wheel reports ~100 per notch.
 *  Dividing by this turns both into a comfortable zoom rate. */
const ZOOM_SENSITIVITY = 300;

export interface ViewportController {
  viewport: Viewport;
  setViewport: React.Dispatch<React.SetStateAction<Viewport>>;
  /** True while the user is panning (space/middle drag) — drives the cursor. */
  panning: boolean;
  /** True while the space bar is held, so the board can show a grab cursor. */
  spaceHeld: boolean;
  /** True while two fingers are down. Item dragging must abort when this flips. */
  gestureRef: React.MutableRefObject<boolean>;
  zoomTo: (scale: number) => void;
  zoomToFit: (content: Rect | null) => void;
  /** Begin a pan from a pointerdown the caller decided is a pan (space/middle). */
  beginPan: (e: React.PointerEvent) => void;
}

export function useViewport(hostRef: React.RefObject<HTMLElement | null>): ViewportController {
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const gestureRef = useRef(false);
  // Live touch pointers, for pinch. Keyed by pointerId.
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  // --- wheel ---------------------------------------------------------------
  // Bound manually rather than via onWheel: React attaches wheel listeners as
  // passive, and a passive listener cannot preventDefault — so ctrl+wheel would
  // zoom the whole browser page instead of the board.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = (host as HTMLElement).getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        setViewport((vp) => zoomAt(vp, anchor, vp.scale * Math.exp(-e.deltaY / ZOOM_SENSITIVITY)));
      } else {
        // Shift+wheel is the conventional "pan horizontally" on a mouse with only
        // a vertical wheel.
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setViewport((vp) => ({ ...vp, x: vp.x - dx, y: vp.y - dy }));
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [hostRef]);

  // --- space bar -----------------------------------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      // Space must still type a space inside a sticky's textarea.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      setSpaceHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') setSpaceHeld(false);
    }
    // A blur while space is held would otherwise leave the board stuck in pan mode.
    function onBlur() {
      setSpaceHeld(false);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const beginPan = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setPanning(true);
    const start = { x: e.clientX, y: e.clientY };
    let last = start;
    function onMove(ev: PointerEvent) {
      // A one-finger pan yields the moment a second finger turns the gesture into
      // a pinch — otherwise both handlers would translate the viewport and the
      // board would move at double speed.
      if (gestureRef.current) return;
      const dx = ev.clientX - last.x;
      const dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      setViewport((vp) => ({ ...vp, x: vp.x + dx, y: vp.y + dy }));
    }
    function onUp() {
      setPanning(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    // Listeners go on window, not the element: a fast pan easily outruns the
    // pointer's own element and would otherwise stick.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  // --- two-finger pinch + pan ----------------------------------------------
  // Capture phase on the host, so a second finger registers even when the first
  // one landed on (and is being handled by) an item or the ink surface.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    function onDown(e: PointerEvent) {
      if (e.pointerType !== 'touch') return;
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchesRef.current.size === 2) {
        const [a, b] = [...touchesRef.current.values()];
        pinchRef.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          cx: (a.x + b.x) / 2,
          cy: (a.y + b.y) / 2,
        };
        // Tell whatever drag is in progress to give up: the user has switched
        // from moving one thing to navigating the board.
        gestureRef.current = true;
      }
    }

    function onMove(e: PointerEvent) {
      if (e.pointerType !== 'touch' || !touchesRef.current.has(e.pointerId)) return;
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = pinchRef.current;
      if (!pinch || touchesRef.current.size !== 2) return;
      e.preventDefault();
      const [a, b] = [...touchesRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rect = (host as HTMLElement).getBoundingClientRect();
      const anchor = { x: cx - rect.left, y: cy - rect.top };
      const ratio = pinch.dist > 0 ? dist / pinch.dist : 1;
      // Pan by the centroid's movement and zoom by the spread change in one step,
      // which is what makes a pinch feel like it is pinned to the fingers.
      const panX = cx - pinch.cx;
      const panY = cy - pinch.cy;
      setViewport((vp) => {
        const panned = { ...vp, x: vp.x + panX, y: vp.y + panY };
        return zoomAt(panned, anchor, panned.scale * ratio);
      });
      pinchRef.current = { dist, cx, cy };
    }

    function onUp(e: PointerEvent) {
      if (e.pointerType !== 'touch') return;
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) {
        pinchRef.current = null;
        // Stay latched until the last finger lifts, so releasing one finger of a
        // pinch does not immediately start dragging an item with the other.
        if (touchesRef.current.size === 0) gestureRef.current = false;
      }
    }

    host.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      host.removeEventListener('pointerdown', onDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [hostRef]);

  const zoomTo = useCallback(
    (scale: number) => {
      const host = hostRef.current;
      const w = host?.clientWidth ?? 0;
      const h = host?.clientHeight ?? 0;
      setViewport((vp) => zoomAt(vp, { x: w / 2, y: h / 2 }, clampScale(scale)));
    },
    [hostRef],
  );

  const zoomToFit = useCallback(
    (content: Rect | null) => {
      const host = hostRef.current;
      if (!host) return;
      setViewport(fitViewport(content, host.clientWidth, host.clientHeight));
    },
    [hostRef],
  );

  return { viewport, setViewport, panning, spaceHeld, gestureRef, zoomTo, zoomToFit, beginPan };
}
