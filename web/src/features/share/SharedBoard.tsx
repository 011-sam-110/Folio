// The shared view of a CANVAS note: a collaborative whiteboard.
//
// SCOPE, STATED PLAINLY. A canvas owns two kinds of content — spatial items
// (stickies, shapes, linked notes) that live in canvas_items, and stylus ink that
// lives in note_ink. The share API exposes only the ink half; /api/canvas/:noteId
// is owner-authenticated with no share-scoped equivalent. So a guest sees and
// draws the ink, and the cards are simply not reachable. The header says so
// rather than rendering a board that looks empty for no visible reason.
//
// Everything about how ink is captured and drawn is InkSurface's, unchanged —
// pointer capture, palm rejection, pressure, the two-canvas live/base split. This
// file only supplies the viewport, the tool state and a share-scoped layer.

import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import Tooltip from '../../components/Tooltip';
import InkSurface from '../canvas/InkSurface';
import InkToolbar from '../canvas/InkToolbar';
import { useViewport } from '../canvas/useViewport';
import { defaultColorFor, defaultWidthFor, inkBounds } from '../canvas/strokes';
import type { SharedInkLayer } from './useSharedInk';
import type { InkTool } from '../../lib/types';
import '../canvas/canvas.css';
import './share.css';

export interface SharedBoardProps {
  ink: SharedInkLayer;
  canEdit: boolean;
}

/** The shared board has no eraser: the share API is append-only (POST /ink with
 *  no DELETE), so an eraser would appear to work and then un-erase on reload. */
type BoardTool = 'move' | 'pen' | 'highlighter';

export default function SharedBoard({ ink, canEdit }: SharedBoardProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { viewport, panning, spaceHeld, zoomTo, zoomToFit, beginPan } = useViewport(hostRef);

  // A view-only visitor can never draw, so the board opens in move mode for them;
  // an editor opens with the pen armed, because drawing is the entire point of
  // being handed a whiteboard link.
  const [tool, setTool] = useState<BoardTool>(canEdit ? 'pen' : 'move');
  const [color, setColor] = useState<Record<'pen' | 'highlighter', string>>({
    pen: defaultColorFor('pen'),
    highlighter: defaultColorFor('highlighter'),
  });
  const [width, setWidth] = useState<Record<'pen' | 'highlighter', number>>({
    pen: defaultWidthFor('pen'),
    highlighter: defaultWidthFor('highlighter'),
  });
  const [fingerDraws, setFingerDraws] = useState(false);

  // Frame whatever is already on the board, ONCE, as soon as it has loaded — so
  // arriving at a link does not drop you on empty space beside everyone else's
  // work. Latched, because re-fitting every time a stroke lands would yank the
  // view out from under whoever is drawing.
  const fittedRef = useRef(false);
  const fitRef = useRef<() => void>(() => {});
  fitRef.current = () => zoomToFit(inkBounds(ink.strokes));
  useEffect(() => {
    if (!ink.ready || fittedRef.current) return;
    fittedRef.current = true;
    fitRef.current();
  }, [ink.ready]);

  const handleBoardPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Middle-drag and space-drag pan regardless of tool — the convention every
      // spatial tool shares. In move mode a plain drag pans too.
      if (e.button === 1 || spaceHeld || (tool === 'move' && e.button === 0)) {
        beginPan(e);
      }
    },
    [beginPan, spaceHeld, tool],
  );

  // Flush queued strokes when leaving, so the last marks are not lost in the
  // upload debounce.
  const flushRef = useRef(ink.flush);
  flushRef.current = ink.flush;
  useEffect(() => {
    return () => {
      void flushRef.current();
    };
  }, []);

  const armed = canEdit && tool !== 'move';
  const activeKey = tool === 'highlighter' ? 'highlighter' : 'pen';
  const cursor = spaceHeld || panning ? (panning ? 'grabbing' : 'grab') : armed ? 'crosshair' : 'default';

  return (
    <div className="sh-board">
      <div
        ref={hostRef}
        className={`cv-board${panning ? ' is-panning' : ''}`}
        style={{ cursor }}
        onPointerDown={handleBoardPointerDown}
      >
        <div
          className="cv-grid"
          aria-hidden="true"
          style={{
            backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
        />

        <InkSurface
          layer={ink}
          viewport={viewport}
          active={armed}
          tool={(tool === 'move' ? 'pen' : tool) as InkTool}
          color={color[activeKey]}
          width={width[activeKey]}
          fingerDraws={fingerDraws}
        />

        {canEdit && (
          <div className="sh-board__tools">
            <div className="cv-tools" role="toolbar" aria-label="Board mode">
              <Tooltip content="Move around the board">
                <button
                  type="button"
                  className={`cv-tools__btn${tool === 'move' ? ' is-active' : ''}`}
                  aria-label="Move"
                  aria-pressed={tool === 'move'}
                  onClick={() => setTool('move')}
                >
                  <Icon name="cursor" size={16} />
                </button>
              </Tooltip>
            </div>
            <InkToolbar
              tool={tool === 'move' ? 'pen' : tool}
              onToolChange={(t) => setTool(t === 'eraser' ? 'pen' : t)}
              color={color[activeKey]}
              onColorChange={(c) => setColor((p) => ({ ...p, [activeKey]: c }))}
              width={width[activeKey]}
              onWidthChange={(w) => setWidth((p) => ({ ...p, [activeKey]: w }))}
              fingerDraws={fingerDraws}
              onFingerDrawsChange={setFingerDraws}
              onClear={() => {}}
              allowErase={false}
            />
          </div>
        )}

        {/* Same chrome and the same chevron idiom as the owner's board, so the two
            surfaces do not read as different products. */}
        <div className="cv-chrome cv-chrome--right sh-board__zoom">
          <Tooltip content="Zoom out" placement="top">
            <button type="button" className="cv-chrome__btn" aria-label="Zoom out" onClick={() => zoomTo(viewport.scale / 1.25)}>
              <Icon name="chevron-down" size={15} />
            </button>
          </Tooltip>
          <button
            type="button"
            className="cv-chrome__zoom"
            onClick={() => zoomTo(1)}
            title="Reset to 100%"
            aria-label={`Zoom ${Math.round(viewport.scale * 100)} percent. Reset to 100 percent`}
          >
            {Math.round(viewport.scale * 100)}%
          </button>
          <Tooltip content="Zoom in" placement="top">
            <button type="button" className="cv-chrome__btn" aria-label="Zoom in" onClick={() => zoomTo(viewport.scale * 1.25)}>
              <Icon name="chevron-down" size={15} style={{ transform: 'rotate(180deg)' }} />
            </button>
          </Tooltip>
          <Tooltip content="Zoom to fit" placement="top">
            <button
              type="button"
              className="cv-chrome__btn"
              aria-label="Zoom to fit"
              onClick={() => zoomToFit(inkBounds(ink.strokes))}
            >
              <Icon name="maximize" size={15} />
            </button>
          </Tooltip>
        </div>

        {!canEdit && (
          <div className="sh-board__hint">
            <Icon name="lock" size={13} /> View only. You can look around but not draw
          </div>
        )}
      </div>
    </div>
  );
}
