// Render a canvas board (items + stylus ink) to a STATIC raster image.
//
// v1 is a snapshot, not a live link: the produced PNG is uploaded as an ordinary image
// attachment and inserted as an image node, so it does not track later edits to the board.
// LIVE-LINKING (re-rendering the figure when the board changes, or storing the board id on
// the node and refreshing on open) is a deliberate future enhancement — see the module
// README note in canvasInsertInsertable.ts.
//
// The ink is drawn with canvas/strokes.ts's `drawLayer` — the exact renderer the live board
// uses — so ink in the snapshot is pixel-identical to ink on the board. Items are drawn
// here because the board renders them as React/DOM, which cannot be rasterised without a
// DOM-to-canvas dependency (and the strict CSP rules those out anyway).
//
// Colours are a FIXED portable palette (white page, dark ink), not theme tokens: the image
// is frozen at capture time and shown forever in whatever theme the reader has, so it must
// be legible on both — the same reasoning canvas/items.ts gives for sticky colours.

import { api } from '../../../../lib/api';
import type { CanvasItem, InkStroke } from '../../../../lib/types';
import { bounds, toScreen, type Rect, type Viewport } from '../../../canvas/geometry';
import { drawLayer, inkBounds, type LocalStroke } from '../../../canvas/strokes';

const PAGE_BG = '#ffffff';
const INK = '#1f2328';
const INK_SOFT = '#57606a';
const LINE = '#d7d7d4';
const STICKY_DEFAULT = '#ffe8a3';
const SHAPE_DEFAULT = '#4f46e5';

export interface BoardData {
  items: CanvasItem[];
  strokes: LocalStroke[];
}

export interface SnapshotOptions {
  /** Device-pixel multiplier for crispness (capped by maxDim). */
  scale?: number;
  /** World-unit margin drawn around the content. */
  padding?: number;
  /** Hard cap on either output dimension in pixels, so a sprawling board can't mint a
   *  100-megapixel canvas. */
  maxDim?: number;
}

/** Same defensive read as canvas/useInkLayer's normalizeStroke — a bad ink row is skipped,
 *  never allowed to crash the render. */
function normalizeStroke(s: InkStroke): LocalStroke | null {
  if (!s || !Array.isArray(s.points) || s.points.length === 0) return null;
  const points = s.points.filter(
    (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  if (points.length === 0) return null;
  return {
    id: s.id,
    points: points.map((p) => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0.5]),
    color: typeof s.color === 'string' ? s.color : INK,
    width: Number.isFinite(s.width) ? s.width : 3,
    tool: s.tool === 'highlighter' ? 'highlighter' : 'pen',
  };
}

/** Fetch everything needed to render one board. Ink works on any note id, so this also
 *  captures ink annotations on a board that has no items. */
export async function loadBoard(noteId: string): Promise<BoardData> {
  const [canvas, ink] = await Promise.all([api.canvas(noteId), api.ink(noteId)]);
  const strokes = ink.strokes.map(normalizeStroke).filter((s): s is LocalStroke => s !== null);
  return { items: canvas.items, strokes };
}

export function boardIsEmpty(board: BoardData): boolean {
  return board.items.length === 0 && board.strokes.length === 0;
}

/** World-space bounds of everything on the board, or null when it is empty. */
export function contentBounds(board: BoardData): Rect | null {
  const rects: Rect[] = board.items.map((it) => ({ x: it.x, y: it.y, width: it.width, height: it.height }));
  const ib = inkBounds(board.strokes);
  if (ib) rects.push(ib);
  return bounds(rects);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (ctx.measureText(trial).width > maxWidth && line) {
        out.push(line);
        line = word;
        if (out.length >= maxLines) return truncateLast(out, ctx, maxWidth);
      } else {
        line = trial;
      }
    }
    if (line) out.push(line);
    if (out.length >= maxLines) return truncateLast(out, ctx, maxWidth);
  }
  return out;
}

function truncateLast(lines: string[], ctx: CanvasRenderingContext2D, maxWidth: number): string[] {
  const clipped = lines.slice(0, Math.max(1, lines.length));
  let last = clipped[clipped.length - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  clipped[clipped.length - 1] = `${last}…`;
  return clipped;
}

function drawItem(
  ctx: CanvasRenderingContext2D,
  item: CanvasItem,
  vp: Viewport,
  images: Map<string, HTMLImageElement | null>,
): void {
  const tl = toScreen({ x: item.x, y: item.y }, vp);
  const w = item.width * vp.scale;
  const h = item.height * vp.scale;
  const data = item.data ?? {};

  ctx.save();
  if (item.rotation) {
    ctx.translate(tl.x + w / 2, tl.y + h / 2);
    ctx.rotate((item.rotation * Math.PI) / 180);
    ctx.translate(-(tl.x + w / 2), -(tl.y + h / 2));
  }

  switch (item.kind) {
    case 'sticky': {
      ctx.fillStyle = typeof data.color === 'string' ? data.color : STICKY_DEFAULT;
      roundRectPath(ctx, tl.x, tl.y, w, h, 8 * vp.scale);
      ctx.fill();
      drawItemText(ctx, data.text ?? '', tl.x, tl.y, w, h, vp.scale, INK);
      break;
    }
    case 'text': {
      drawItemText(ctx, data.text ?? '', tl.x, tl.y, w, h, vp.scale, INK);
      break;
    }
    case 'shape': {
      const color = typeof data.color === 'string' ? data.color : SHAPE_DEFAULT;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 2 * vp.scale);
      if (data.shape === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(tl.x + w / 2, tl.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (data.shape === 'arrow') {
        drawArrow(ctx, tl.x, tl.y + h / 2, tl.x + w, tl.y + h / 2, color, vp.scale);
      } else {
        roundRectPath(ctx, tl.x, tl.y, w, h, 4 * vp.scale);
        ctx.stroke();
      }
      break;
    }
    case 'image': {
      const img = images.get(item.id) ?? null;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, tl.x, tl.y, w, h);
      } else {
        drawPlaceholder(ctx, tl.x, tl.y, w, h, vp.scale, 'image');
      }
      break;
    }
    case 'link': {
      ctx.fillStyle = PAGE_BG;
      roundRectPath(ctx, tl.x, tl.y, w, h, 8 * vp.scale);
      ctx.fill();
      ctx.strokeStyle = LINE;
      ctx.lineWidth = Math.max(1, 1 * vp.scale);
      ctx.stroke();
      drawItemText(ctx, data.title || 'Untitled note', tl.x, tl.y, w, h, vp.scale, INK, `${13 * vp.scale}px`, 600);
      break;
    }
    default: {
      // 'ink' items (data.strokes) and 'embed' are never authored by the UI; render ink if
      // present, otherwise a labelled placeholder so nothing silently vanishes.
      const raw = (data as { strokes?: unknown }).strokes;
      if (Array.isArray(raw)) {
        const strokes = raw
          .map((s) => normalizeStroke(s as InkStroke))
          .filter((s): s is LocalStroke => s !== null);
        if (strokes.length > 0) {
          drawLayer(ctx, strokes, vp);
          break;
        }
      }
      drawPlaceholder(ctx, tl.x, tl.y, w, h, vp.scale, item.kind);
    }
  }
  ctx.restore();
}

function drawItemText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  color: string,
  font = `${15 * scale}px`,
  weight = 400,
): void {
  const t = text.trim();
  if (!t) return;
  const pad = 12 * scale;
  const lineH = 20 * scale;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.font = `${weight} ${font} -apple-system, "Segoe UI", system-ui, sans-serif`;
  const maxLines = Math.max(1, Math.floor((h - pad * 2) / lineH));
  const lines = wrapLines(ctx, t, w - pad * 2, maxLines);
  lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad + i * lineH));
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  scale: number,
): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const head = 10 * scale;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  label: string,
): void {
  ctx.strokeStyle = LINE;
  ctx.lineWidth = Math.max(1, 1 * scale);
  ctx.setLineDash([6 * scale, 4 * scale]);
  roundRectPath(ctx, x, y, w, h, 6 * scale);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = INK_SOFT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = `500 ${12 * scale}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.textAlign = 'start';
}

/**
 * Draw the whole board into `ctx`. PURE (no network): callers pass a preloaded image map.
 * This is the function the render proof exercises against a real canvas.
 */
export function drawBoard(
  ctx: CanvasRenderingContext2D,
  board: BoardData,
  vp: Viewport,
  images: Map<string, HTMLImageElement | null>,
): void {
  const ordered = [...board.items].sort((a, b) => a.z - b.z);
  for (const item of ordered) drawItem(ctx, item, vp, images);
  // Ink always sits on top — you annotate over the cards, same as the live board.
  drawLayer(ctx, board.strokes, vp);
}

async function preloadImages(items: CanvasItem[]): Promise<Map<string, HTMLImageElement | null>> {
  const map = new Map<string, HTMLImageElement | null>();
  await Promise.all(
    items
      .filter((it) => it.kind === 'image' && typeof it.data?.url === 'string')
      .map(
        (it) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            // Same-origin /uploads: the session cookie rides along and the canvas is NOT
            // tainted, so toBlob() still works. A failed load resolves to a placeholder.
            img.onload = () => {
              map.set(it.id, img);
              resolve();
            };
            img.onerror = () => {
              map.set(it.id, null);
              resolve();
            };
            img.src = it.data.url as string;
          }),
      ),
  );
  return map;
}

/** Build a real canvas element sized to the board's content and paint it. */
export async function renderBoardToCanvas(board: BoardData, opts: SnapshotOptions = {}): Promise<HTMLCanvasElement> {
  const padding = opts.padding ?? 48;
  const maxDim = opts.maxDim ?? 2400;
  const b = contentBounds(board) ?? { x: 0, y: 0, width: 600, height: 400 };

  const worldW = b.width + padding * 2;
  const worldH = b.height + padding * 2;
  const s = Math.max(0.1, Math.min(opts.scale ?? 2, maxDim / worldW, maxDim / worldH));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(worldW * s));
  canvas.height = Math.max(1, Math.round(worldH * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context for the snapshot');

  ctx.fillStyle = PAGE_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // world (b.x - padding, b.y - padding) -> canvas (0, 0)
  const vp: Viewport = { x: -(b.x - padding) * s, y: -(b.y - padding) * s, scale: s };
  const images = await preloadImages(board.items);
  drawBoard(ctx, board, vp, images);
  return canvas;
}

export interface RenderedSnapshot {
  blob: Blob;
  width: number;
  height: number;
}

export async function renderBoardToPngBlob(board: BoardData, opts: SnapshotOptions = {}): Promise<RenderedSnapshot> {
  const canvas = await renderBoardToCanvas(board, opts);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the snapshot to PNG');
  return { blob, width: canvas.width, height: canvas.height };
}

/** Convenience for a data-URL preview (used by the picker thumbnails). */
export async function renderBoardToDataUrl(board: BoardData, opts: SnapshotOptions = {}): Promise<string> {
  const canvas = await renderBoardToCanvas(board, opts);
  return canvas.toDataURL('image/png');
}
