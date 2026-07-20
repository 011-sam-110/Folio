// Pure viewport + hit-testing maths shared by the board, the connector layer and
// the ink surface. No React, no DOM — so the tricky bits (screen<->world, edge
// clipping) are reasoned about and reused in exactly one place.

export interface Viewport {
  /** Screen-space translation applied AFTER scaling. */
  x: number;
  y: number;
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

export const IDENTITY: Viewport = { x: 0, y: 0, scale: 1 };

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** screen = world * scale + offset */
export function toScreen(p: Point, vp: Viewport): Point {
  return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
}

/** world = (screen - offset) / scale */
export function toWorld(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

/**
 * Zoom about a fixed screen point (the cursor, or a pinch centroid).
 *
 * The invariant is that the world point currently under `anchor` must still be
 * under `anchor` afterwards — that is what makes ctrl+wheel feel like the canvas
 * is being pushed away from you rather than recentred on the origin.
 */
export function zoomAt(vp: Viewport, anchor: Point, nextScale: number): Viewport {
  const scale = clampScale(nextScale);
  const world = toWorld(anchor, vp);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

export function rectOf(item: Rect): Rect {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

export function centerOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
}

/** Axis-aligned bounding box of a set of rects, or null for an empty set. */
export function bounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Normalise a drag (which can run right-to-left / bottom-to-top) into a Rect. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Where the centre-to-centre line leaves `rect`.
 *
 * Connectors are anchored to the border rather than the centre, so an arrowhead
 * lands ON the card's edge instead of being hidden underneath it. Because this is
 * derived from the live rect every render, edges re-route for free as items move
 * — there is no stored routing to invalidate.
 */
export function borderPoint(rect: Rect, toward: Point): Point {
  const c = centerOf(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;

  const hw = rect.width / 2;
  const hh = rect.height / 2;
  // Scale the direction vector until it hits whichever edge pair it reaches first.
  // Guarding against division by zero is what keeps a purely vertical or purely
  // horizontal connector from producing NaN and vanishing.
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Squared distance from p to segment ab — squared to keep the eraser's inner
 *  loop free of sqrt, since it runs over every point of every stroke. */
export function distToSegmentSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = p.x - cx;
  const ey = p.y - cy;
  return ex * ex + ey * ey;
}

/**
 * Fit `content` inside `viewport` (both in their own spaces) with padding.
 * Returns the identity-ish default when there is nothing to fit, so "zoom to fit"
 * on an empty board resets to 100% at the origin rather than dividing by zero.
 */
export function fitViewport(content: Rect | null, viewportW: number, viewportH: number, padding = 80): Viewport {
  if (!content || content.width <= 0 || content.height <= 0) {
    return { x: viewportW / 2, y: viewportH / 2, scale: 1 };
  }
  const scale = clampScale(
    Math.min((viewportW - padding * 2) / content.width, (viewportH - padding * 2) / content.height, MAX_SCALE),
  );
  const c = centerOf(content);
  return { scale, x: viewportW / 2 - c.x * scale, y: viewportH / 2 - c.y * scale };
}
