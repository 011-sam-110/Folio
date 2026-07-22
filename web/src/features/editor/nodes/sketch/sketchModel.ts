// Pure model + persistence helpers for the inline sketch node. No React, no DOM — so
// the serialise/round-trip logic that guarantees a sketch survives a reload can be
// reasoned about (and tested) in one place, exactly like canvas/geometry.ts.
//
// PERSISTENCE CHOICE (option i — vector strokes in node attrs, not a rendered image):
//   * A sketch is small vector data. Storing the strokes as JSON in the node's attrs
//     means the drawing round-trips through the note's EXISTING content-JSON autosave —
//     no extra attachment upload, no network round-trip, no orphaned-file lifecycle.
//   * It stays fully editable on reopen (draw more, erase, undo) because the vector
//     source is retained. A baked raster would be a dead end for editing.
//   * It re-renders crisply at any DPR / container width / theme because we redraw from
//     vectors; a raster would blur when scaled and freeze one theme's colours in.
//   The alternative (upload a PNG *and* keep the strokes) doubles storage and adds an
//   attachment lifecycle for no gain here — we can always re-render from the strokes.
//   That trade only pays off for server-side thumbnails or huge strokes, neither of
//   which an inline note sketch has.

import type { InkPoint } from '../../../../lib/types';
import type { LocalStroke } from '../../../canvas/strokes';

/** World coordinate space of the pad. Strokes are stored in 0..WORLD_W x 0..h, so they
 *  re-render proportionally at ANY rendered width — the on-screen viewport scale is just
 *  renderedWidth / WORLD_W. WORLD_W is sized so a desktop-width pad renders at ~scale 1,
 *  keeping the pen widths (1.5..10 world units) reading true. */
export const SKETCH_WORLD_W = 720;
export const SKETCH_WORLD_H_DEFAULT = 440;
export const SKETCH_MIN_WORLD_H = 220;
export const SKETCH_MAX_WORLD_H = 1200;

export type SketchBg = 'dots' | 'grid' | 'plain';

/**
 * The persisted shape stored in the node's `strokes` attr. Deliberately a SUBSET of
 * LocalStroke — no ephemeral `id` / `pending` — so the doc JSON stays clean and every
 * reopen mints fresh local ids.
 */
export interface SketchStroke {
  points: InkPoint[];
  color: string;
  width: number;
  tool: 'pen' | 'highlighter';
}

let seq = 0;
/** Local-only id. Never persisted; only needed so the eraser/undo can target a stroke
 *  between mounts. */
export const nextSketchId = (): string => `sk-${++seq}`;

export function serializeStrokes(strokes: readonly LocalStroke[]): SketchStroke[] {
  return strokes.map((s) => ({ points: s.points, color: s.color, width: s.width, tool: s.tool }));
}

/**
 * Defensive parse of the `strokes` attr. Node attrs are opaque JSON that may have been
 * hand-edited, produced by an older build, or pasted from elsewhere, so anything
 * malformed is dropped rather than thrown — a bad blob must degrade to an empty pad,
 * never crash the editor.
 */
export function deserializeStrokes(raw: unknown): LocalStroke[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalStroke[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as Record<string, unknown>;
    if (!Array.isArray(rec.points)) continue;
    const points: InkPoint[] = [];
    for (const p of rec.points) {
      if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        points.push([Number(p[0]), Number(p[1]), Number.isFinite(p[2]) ? Number(p[2]) : 0.5]);
      }
    }
    if (points.length === 0) continue;
    out.push({
      id: nextSketchId(),
      points,
      color: typeof rec.color === 'string' ? rec.color : '#1f2328',
      width: Number.isFinite(rec.width) ? Number(rec.width) : 3,
      tool: rec.tool === 'highlighter' ? 'highlighter' : 'pen',
    });
  }
  return out;
}

/** Clamp a stored world height into the allowed band, tolerating junk. */
export function clampWorldH(h: unknown): number {
  const n = typeof h === 'number' && Number.isFinite(h) ? h : SKETCH_WORLD_H_DEFAULT;
  return Math.min(SKETCH_MAX_WORLD_H, Math.max(SKETCH_MIN_WORLD_H, Math.round(n)));
}

export function normalizeBg(bg: unknown): SketchBg {
  return bg === 'grid' || bg === 'plain' ? bg : 'dots';
}
