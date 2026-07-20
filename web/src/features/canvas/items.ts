// Defaults and palettes for board items. Kept out of the component files so the
// `react/only-export-components` rule stays happy and so the board can size a new
// item before deciding which component will render it.

import type { CanvasItemData, CanvasItemKind } from '../../lib/types';

/**
 * Sticky palette. These are literal hex values rather than theme tokens on
 * purpose: a sticky's colour is CONTENT the user chose, not chrome, so it must
 * look the same to everyone the board is shared with and must not flip when the
 * reader's theme does. Dark-theme legibility is handled by pairing each with a
 * fixed dark ink colour (see canvas.css) rather than by swapping the background.
 */
export const STICKY_COLORS = ['#ffe8a3', '#ffd0d9', '#c9e8ff', '#c9f2d8', '#e5d4ff', '#ffffff'] as const;

/** Shape outline colours — same reasoning as STICKY_COLORS. */
export const SHAPE_COLORS = ['#4f46e5', '#d1242f', '#1a7f37', '#c2680a', '#7c3aed', '#57606a'] as const;

export const DEFAULT_SIZES: Record<CanvasItemKind, { width: number; height: number }> = {
  sticky: { width: 200, height: 200 },
  text: { width: 260, height: 80 },
  shape: { width: 220, height: 150 },
  image: { width: 320, height: 240 },
  link: { width: 260, height: 96 },
};

export const MIN_SIZE = 48;

export function defaultDataFor(kind: CanvasItemKind, shape?: 'rect' | 'ellipse' | 'arrow'): CanvasItemData {
  switch (kind) {
    case 'sticky':
      return { text: '', color: STICKY_COLORS[0] };
    case 'text':
      return { text: '' };
    case 'shape':
      return { shape: shape ?? 'rect', color: SHAPE_COLORS[0] };
    default:
      return {};
  }
}

/** Human label used in undo toasts and aria-labels. */
export function labelFor(kind: CanvasItemKind): string {
  switch (kind) {
    case 'sticky':
      return 'sticky note';
    case 'text':
      return 'text';
    case 'shape':
      return 'shape';
    case 'image':
      return 'image';
    case 'link':
      return 'note link';
    default:
      return 'item';
  }
}

/** Resize handle positions, as unit multipliers of the item's box. */
export const HANDLES = [
  { id: 'nw', fx: 0, fy: 0, cursor: 'nwse-resize' },
  { id: 'ne', fx: 1, fy: 0, cursor: 'nesw-resize' },
  { id: 'se', fx: 1, fy: 1, cursor: 'nwse-resize' },
  { id: 'sw', fx: 0, fy: 1, cursor: 'nesw-resize' },
] as const;

export type HandleId = (typeof HANDLES)[number]['id'];
