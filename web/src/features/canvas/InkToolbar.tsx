// Floating ink controls. Deliberately one row: tool, then the palette and widths
// for the CURRENT tool only. Showing pen colours while the eraser is selected is
// the kind of clutter that makes a drawing toolbar feel like a settings dialog.

import Icon from '../../components/Icon';
import Tooltip from '../../components/Tooltip';
import type { InkTool } from '../../lib/types';
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS } from './strokes';

export interface InkToolbarProps {
  tool: InkTool;
  onToolChange: (t: InkTool) => void;
  color: string;
  onColorChange: (c: string) => void;
  width: number;
  onWidthChange: (w: number) => void;
  fingerDraws: boolean;
  onFingerDrawsChange: (v: boolean) => void;
  onClear: () => void;
  /** Present on the doc-note overlay, where the toolbar can dismiss the layer. */
  onClose?: () => void;
  /** Hides the eraser and "clear all" together. Off for share links, whose ink
   *  API is append-only (POST with no DELETE) — an eraser there would appear to
   *  work and then un-erase on the next load, which is worse than not having one. */
  allowErase?: boolean;
}

const TOOLS: Array<{ id: InkTool; icon: 'pen' | 'highlighter' | 'eraser'; label: string }> = [
  { id: 'pen', icon: 'pen', label: 'Pen' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser — tap a stroke to remove it' },
];

export default function InkToolbar({
  tool,
  onToolChange,
  color,
  onColorChange,
  width,
  onWidthChange,
  fingerDraws,
  onFingerDrawsChange,
  onClear,
  onClose,
  allowErase = true,
}: InkToolbarProps) {
  const isEraser = tool === 'eraser';
  const colors = tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widths = tool === 'highlighter' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const tools = allowErase ? TOOLS : TOOLS.filter((t) => t.id !== 'eraser');

  return (
    <div className="cv-inkbar" role="toolbar" aria-label="Ink tools">
      <div className="cv-inkbar__group">
        {tools.map((t) => (
          <Tooltip key={t.id} content={t.label}>
            <button
              type="button"
              className={`cv-inkbar__btn${tool === t.id ? ' is-active' : ''}`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              onClick={() => onToolChange(t.id)}
            >
              <Icon name={t.icon} size={16} />
            </button>
          </Tooltip>
        ))}
      </div>

      {!isEraser && (
        <>
          <span className="cv-inkbar__sep" aria-hidden="true" />
          <div className="cv-inkbar__group" role="group" aria-label="Colour">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className={`cv-inkbar__swatch${color === c ? ' is-active' : ''}`}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                aria-pressed={color === c}
                onClick={() => onColorChange(c)}
              />
            ))}
          </div>

          <span className="cv-inkbar__sep" aria-hidden="true" />
          <div className="cv-inkbar__group" role="group" aria-label="Width">
            {widths.map((w) => (
              <button
                key={w}
                type="button"
                className={`cv-inkbar__width${width === w ? ' is-active' : ''}`}
                aria-label={`Width ${w}`}
                aria-pressed={width === w}
                onClick={() => onWidthChange(w)}
              >
                {/* The dot IS the size preview, capped so the fattest highlighter
                    still fits the button. */}
                <span style={{ width: Math.min(16, 3 + w * 0.6), height: Math.min(16, 3 + w * 0.6) }} />
              </button>
            ))}
          </div>
        </>
      )}

      <span className="cv-inkbar__sep" aria-hidden="true" />
      <div className="cv-inkbar__group">
        <Tooltip
          content={
            fingerDraws
              ? 'Finger drawing is on — turn it off to use a finger for panning'
              : 'Finger drawing is off. A stylus always draws; a finger pans and zooms'
          }
        >
          <button
            type="button"
            className={`cv-inkbar__btn${fingerDraws ? ' is-active' : ''}`}
            aria-label="Draw with finger"
            aria-pressed={fingerDraws}
            onClick={() => onFingerDrawsChange(!fingerDraws)}
          >
            <Icon name="hand" size={16} />
          </button>
        </Tooltip>
        {allowErase && (
          <Tooltip content="Erase all ink on this note">
            <button type="button" className="cv-inkbar__btn" aria-label="Clear all ink" onClick={onClear}>
              <Icon name="trash" size={15} />
            </button>
          </Tooltip>
        )}
        {onClose && (
          <Tooltip content="Close the ink layer">
            <button type="button" className="cv-inkbar__btn" aria-label="Close ink layer" onClick={onClose}>
              <Icon name="x" size={15} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
