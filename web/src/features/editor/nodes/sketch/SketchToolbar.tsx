// The sketch pad's own toolbar. Kept separate from canvas/InkToolbar so it can carry
// pad-specific controls (undo / redo) without editing a component the board and the
// doc-note overlay also render. It reuses the SAME palette + width constants from
// canvas/strokes.ts, so pen colours and nib sizes match the rest of the app exactly.

import Icon, { type IconName } from '../../../../components/Icon';
import Tooltip from '../../../../components/Tooltip';
import type { InkTool } from '../../../../lib/types';
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS } from '../../../canvas/strokes';

export interface SketchToolbarProps {
  tool: InkTool;
  onToolChange: (t: InkTool) => void;
  color: string;
  onColorChange: (c: string) => void;
  width: number;
  onWidthChange: (w: number) => void;
  fingerDraws: boolean;
  onFingerDrawsChange: (v: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
}

const TOOLS: Array<{ id: InkTool; icon: IconName; label: string }> = [
  { id: 'pen', icon: 'pen', label: 'Pen' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser: tap a stroke to remove it' },
];

export default function SketchToolbar({
  tool,
  onToolChange,
  color,
  onColorChange,
  width,
  onWidthChange,
  fingerDraws,
  onFingerDrawsChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
}: SketchToolbarProps) {
  const isEraser = tool === 'eraser';
  const colors = tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const widths = tool === 'highlighter' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;

  return (
    <div className="sk-bar" role="toolbar" aria-label="Sketch tools">
      <div className="sk-bar__group">
        {TOOLS.map((t) => (
          <Tooltip key={t.id} content={t.label}>
            <button
              type="button"
              className={`sk-bar__btn${tool === t.id ? ' is-active' : ''}`}
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
          <span className="sk-bar__sep" aria-hidden="true" />
          <div className="sk-bar__group" role="group" aria-label="Colour">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className={`sk-bar__swatch${color === c ? ' is-active' : ''}`}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                aria-pressed={color === c}
                onClick={() => onColorChange(c)}
              />
            ))}
          </div>

          <span className="sk-bar__sep" aria-hidden="true" />
          <div className="sk-bar__group" role="group" aria-label="Width">
            {widths.map((w) => (
              <button
                key={w}
                type="button"
                className={`sk-bar__width${width === w ? ' is-active' : ''}`}
                aria-label={`Width ${w}`}
                aria-pressed={width === w}
                onClick={() => onWidthChange(w)}
              >
                {/* The dot IS the size preview, capped so the fattest highlighter fits. */}
                <span style={{ width: Math.min(16, 3 + w * 0.6), height: Math.min(16, 3 + w * 0.6) }} />
              </button>
            ))}
          </div>
        </>
      )}

      <span className="sk-bar__sep" aria-hidden="true" />
      <div className="sk-bar__group">
        <Tooltip content="Undo">
          <button
            type="button"
            className="sk-bar__btn"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={onUndo}
          >
            <Icon name="undo" size={16} />
          </button>
        </Tooltip>
        <Tooltip content="Redo">
          <button
            type="button"
            className="sk-bar__btn"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Icon name="redo" size={16} />
          </button>
        </Tooltip>
        <Tooltip
          content={
            fingerDraws
              ? 'Finger drawing is on. Turn it off to scroll past the pad on a touchscreen'
              : 'Finger drawing is off. A stylus always draws; a finger scrolls'
          }
        >
          <button
            type="button"
            className={`sk-bar__btn${fingerDraws ? ' is-active' : ''}`}
            aria-label="Draw with finger"
            aria-pressed={fingerDraws}
            onClick={() => onFingerDrawsChange(!fingerDraws)}
          >
            <Icon name="hand" size={16} />
          </button>
        </Tooltip>
        <Tooltip content="Clear the sketch">
          <button type="button" className="sk-bar__btn" aria-label="Clear the sketch" onClick={onClear}>
            <Icon name="trash" size={15} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
