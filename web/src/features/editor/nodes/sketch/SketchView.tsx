// React node view for the inline sketch pad.
//
// Reuse map:
//   * canvas/InkSurface  - the entire drawable surface: pointer capture, palm rejection,
//     Apple-Pencil pressure, DPR-correct two-canvas rendering. Unchanged.
//   * canvas/strokes.ts  - the renderer + palettes, via InkSurface and the toolbar.
//   * canvas/useUndoStack - command-stack undo/redo, same as the doc-note overlay.
//   * useSketchLayer     - OUR InkLayer, swapping server persistence for node attrs.
//
// The pad draws in a fixed world space (0..SKETCH_WORLD_W wide); the on-screen viewport
// scale is just renderedWidth / SKETCH_WORLD_W, so the same strokes re-render proportionally
// whether the note is 720px wide on a laptop or 340px on a phone.

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import type { InkTool } from '../../../../lib/types';
import { toast } from '../../../../components/Toast';
import InkSurface from '../../../canvas/InkSurface';
import { defaultColorFor, defaultWidthFor, type LocalStroke } from '../../../canvas/strokes';
import { useUndoStack } from '../../../canvas/useUndoStack';
import { useSketchLayer } from './useSketchLayer';
import {
  clampWorldH,
  normalizeBg,
  SKETCH_WORLD_W,
  type SketchStroke,
} from './sketchModel';
import SketchToolbar from './SketchToolbar';
import './sketch.css';

export default function SketchView({ node, updateAttributes, editor, selected }: NodeViewProps) {
  const editable = editor.isEditable;
  const worldH = clampWorldH(node.attrs.h);
  const bg = normalizeBg(node.attrs.bg);

  // updateAttributes is a fresh closure each render; funnel through a ref so the layer's
  // onChange identity is stable and the layer hook isn't rebuilt per stroke.
  const updRef = useRef(updateAttributes);
  updRef.current = updateAttributes;
  const onChange = useCallback((strokes: SketchStroke[]) => updRef.current({ strokes }), []);

  const layer = useSketchLayer(node.attrs.strokes, onChange);
  const undo = useUndoStack();

  const [tool, setTool] = useState<InkTool>('pen');
  const [color, setColor] = useState<Record<'pen' | 'highlighter', string>>({
    pen: defaultColorFor('pen'),
    highlighter: defaultColorFor('highlighter'),
  });
  const [width, setWidth] = useState<Record<'pen' | 'highlighter', number>>({
    pen: defaultWidthFor('pen'),
    highlighter: defaultWidthFor('highlighter'),
  });
  // Unlike a board (where a finger pans), a pad has nothing to pan - so a finger draws by
  // default. The toolbar toggle turns it off when the reader needs to scroll past the pad.
  const [fingerDraws, setFingerDraws] = useState(true);

  // Measure the rendered width to derive the viewport scale. Until it is known we render
  // nothing (scale 0), which avoids a one-frame stroke-squashing flash on first paint.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const w = host.clientWidth;
      if (w > 0) setScale(w / SKETCH_WORLD_W);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const handleStrokeCommitted = useCallback(
    (stroke: LocalStroke) => {
      const ref = { current: stroke };
      undo.push({
        label: 'stroke',
        undo: () => layer.removeStrokes([ref.current.id]),
        redo: () => {
          const revived = layer.restoreStrokes([ref.current]);
          if (revived[0]) ref.current = revived[0];
        },
      });
    },
    [layer, undo],
  );

  const handleErased = useCallback(
    (removed: LocalStroke[]) => {
      const ref = { current: removed };
      undo.push({
        label: removed.length === 1 ? 'erase' : `erase ${removed.length} strokes`,
        undo: () => {
          const revived = layer.restoreStrokes(ref.current);
          if (revived.length > 0) ref.current = revived;
        },
        redo: () => layer.removeStrokes(ref.current.map((s) => s.id)),
      });
    },
    [layer, undo],
  );

  const handleClear = useCallback(() => {
    const all = layer.strokes;
    if (all.length === 0) return;
    const ref = { current: all };
    void layer.clearAll();
    undo.push({
      label: 'clear sketch',
      undo: () => {
        const revived = layer.restoreStrokes(ref.current);
        if (revived.length > 0) ref.current = revived;
      },
      redo: () => layer.removeStrokes(ref.current.map((s) => s.id)),
    });
  }, [layer, undo]);

  const doUndo = useCallback(() => {
    const entry = undo.undo();
    if (entry) toast(`Undid ${entry.label}`, 'info', { durationMs: 1200 });
  }, [undo]);
  const doRedo = useCallback(() => {
    const entry = undo.redo();
    if (entry) toast(`Redid ${entry.label}`, 'info', { durationMs: 1200 });
  }, [undo]);

  // Keep the pad's own undo/redo from bubbling to the editor's history while a sketch is
  // focused - the editor beneath is not the thing the user means to undo.
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) doRedo();
        else doUndo();
      }
    },
    [doUndo, doRedo],
  );

  const activeKey = tool === 'eraser' ? 'pen' : tool;
  const hasStrokes = layer.strokes.length > 0;

  return (
    <NodeViewWrapper
      className={`folio-sketch${selected ? ' is-selected' : ''}${editable ? '' : ' is-readonly'}`}
      data-type="sketch"
    >
      <div
        ref={hostRef}
        className={`sk-pad sk-pad--${bg}`}
        style={{ aspectRatio: `${SKETCH_WORLD_W} / ${worldH}` }}
        onKeyDown={editable ? onKeyDown : undefined}
        contentEditable={false}
      >
        {scale > 0 && (
          <InkSurface
            layer={layer}
            viewport={{ x: 0, y: 0, scale }}
            active={editable}
            tool={tool}
            color={color[activeKey]}
            width={width[activeKey]}
            fingerDraws={fingerDraws}
            onStrokeCommitted={handleStrokeCommitted}
            onErased={handleErased}
            className="sk-ink"
          />
        )}
        {editable && !hasStrokes && (
          <div className="sk-empty">
            <span className="sk-empty__title">Draw here</span>
            <span className="sk-empty__hint">Pen, mouse or finger. Apple Pencil supported.</span>
          </div>
        )}
      </div>

      {editable && (
        <SketchToolbar
          tool={tool}
          onToolChange={setTool}
          color={color[activeKey]}
          onColorChange={(c) => tool !== 'eraser' && setColor((p) => ({ ...p, [tool]: c }))}
          width={width[activeKey]}
          onWidthChange={(w) => tool !== 'eraser' && setWidth((p) => ({ ...p, [tool]: w }))}
          fingerDraws={fingerDraws}
          onFingerDrawsChange={setFingerDraws}
          canUndo={undo.canUndo}
          canRedo={undo.canRedo}
          onUndo={doUndo}
          onRedo={doRedo}
          onClear={handleClear}
        />
      )}
    </NodeViewWrapper>
  );
}
