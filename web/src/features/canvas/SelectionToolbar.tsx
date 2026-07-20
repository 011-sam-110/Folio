// Actions for the current selection, floating just above it.
//
// Deliberately contextual rather than a permanent toolbar: on a board the user is
// looking at their content, not at chrome, so duplicate/z-order/delete only exist
// once there is something for them to act on.

import Icon from '../../components/Icon';
import Tooltip from '../../components/Tooltip';
import type { CanvasItem } from '../../lib/types';
import { SHAPE_COLORS, STICKY_COLORS } from './items';

export interface SelectionToolbarProps {
  selected: readonly CanvasItem[];
  /** Where to sit, in SCREEN pixels relative to the board host. */
  left: number;
  top: number;
  onColor: (color: string) => void;
  onDuplicate: () => void;
  onBringFront: () => void;
  onSendBack: () => void;
  onDelete: () => void;
}

export default function SelectionToolbar({
  selected,
  left,
  top,
  onColor,
  onDuplicate,
  onBringFront,
  onSendBack,
  onDelete,
}: SelectionToolbarProps) {
  // Colour only applies when every selected item can take one, so the swatches
  // never imply an action that would silently skip half the selection.
  const allSticky = selected.length > 0 && selected.every((i) => i.kind === 'sticky');
  const allShape = selected.length > 0 && selected.every((i) => i.kind === 'shape');
  const colors = allSticky ? STICKY_COLORS : allShape ? SHAPE_COLORS : null;

  return (
    <div
      className="cv-seltoolbar"
      style={{ left, top }}
      // The toolbar sits inside the board, so its own pointer events must not
      // reach the board underneath and clear the selection it is acting on.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {colors && (
        <>
          <div className="cv-seltoolbar__group" role="group" aria-label="Colour">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className="cv-seltoolbar__swatch"
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                onClick={() => onColor(c)}
              />
            ))}
          </div>
          <span className="cv-seltoolbar__sep" aria-hidden="true" />
        </>
      )}

      <Tooltip content={<>Duplicate <kbd>⌘D</kbd></>}>
        <button type="button" className="cv-seltoolbar__btn" aria-label="Duplicate" onClick={onDuplicate}>
          <Icon name="copy" size={15} />
        </button>
      </Tooltip>
      <Tooltip content="Bring to front">
        <button type="button" className="cv-seltoolbar__btn" aria-label="Bring to front" onClick={onBringFront}>
          <Icon name="bring-front" size={15} />
        </button>
      </Tooltip>
      <Tooltip content="Send to back">
        <button type="button" className="cv-seltoolbar__btn" aria-label="Send to back" onClick={onSendBack}>
          <Icon name="send-back" size={15} />
        </button>
      </Tooltip>
      <Tooltip content={<>Delete <kbd>⌫</kbd></>}>
        <button type="button" className="cv-seltoolbar__btn cv-seltoolbar__btn--danger" aria-label="Delete" onClick={onDelete}>
          <Icon name="trash" size={15} />
        </button>
      </Tooltip>
    </div>
  );
}
