// Stylus ink layered over an ORDINARY document note — annotating your lecture
// notes rather than drawing on a board.
//
// The hard part is anchoring. Ink must stick to the TEXT, not to the screen, so
// world coordinates here are measured from the note body's top-left corner. As
// the page scrolls, the body's on-screen position changes and the ink layer's
// viewport offset follows it, which scrolls the ink in lockstep with the words it
// annotates. Storing screen coordinates instead would leave every annotation
// stranded the moment the reader scrolled.
//
// The surface is a fixed-position overlay clipped to the scroll container rather
// than a full-height canvas: a note can be tens of thousands of pixels tall, and
// a canvas bitmap that size (times DPR) is hundreds of megabytes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../components/Toast';
import type { InkTool } from '../../lib/types';
import { defaultColorFor, defaultWidthFor, type LocalStroke } from './strokes';
import { useInkLayer } from './useInkLayer';
import { useUndoStack } from './useUndoStack';
import InkSurface from './InkSurface';
import InkToolbar from './InkToolbar';
import './canvas.css';

export interface NoteInkOverlayProps {
  noteId: string;
  /** The element ink coordinates are measured from — the note body. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export default function NoteInkOverlay({ noteId, anchorRef, open, onClose }: NoteInkOverlayProps) {
  const ink = useInkLayer(noteId, open);
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
  const [fingerDraws, setFingerDraws] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const rafRef = useRef<number | null>(null);

  /** Re-measure where the note body sits inside the scroll container. */
  const measure = useCallback(() => {
    rafRef.current = null;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const scroller = (anchor.closest('.app-main') as HTMLElement | null) ?? document.documentElement;
    const sRect =
      scroller === document.documentElement
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : scroller.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    setFrame({
      left: sRect.left,
      top: sRect.top,
      width: sRect.width,
      height: sRect.height,
      // Offset of the note body's origin within the overlay — this IS the ink
      // viewport translation, and it changes on every scroll tick.
      offsetX: aRect.left - sRect.left,
      offsetY: aRect.top - sRect.top,
    });
  }, [anchorRef]);

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current !== null) return;
    // Coalesce to one measurement per frame: scroll fires far more often than the
    // overlay can usefully redraw.
    rafRef.current = window.requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    if (!open) return;
    measure();
    const anchor = anchorRef.current;
    const scroller = anchor?.closest('.app-main') as HTMLElement | null;
    scroller?.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    const ro = anchor ? new ResizeObserver(scheduleMeasure) : null;
    if (anchor && ro) ro.observe(anchor);
    return () => {
      scroller?.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      ro?.disconnect();
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, [open, measure, scheduleMeasure, anchorRef]);

  // Ctrl/Cmd+Z belongs to the ink layer while it is open — the editor beneath is
  // not receiving input, so its own history would be the wrong thing to undo.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        const entry = e.shiftKey ? undo.redo() : undo.undo();
        if (entry) toast(`${e.shiftKey ? 'Redid' : 'Undid'} ${entry.label}`, 'info', { durationMs: 1400 });
        return;
      }
      if (e.key === 'Escape') onClose();
    }
    // Capture phase so this wins over NotePage's own window-level handler.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, undo, onClose]);

  useEffect(() => {
    if (open) return;
    // Leaving the layer must not strand unsaved strokes in the debounce window.
    void ink.flush();
  }, [open, ink]);

  const handleStrokeCommitted = useCallback(
    (stroke: LocalStroke) => {
      const ref = { current: stroke };
      undo.push({
        label: 'stroke',
        undo: () => ink.removeStrokes([ref.current.id]),
        redo: () => {
          const revived = ink.restoreStrokes([ref.current]);
          if (revived[0]) ref.current = revived[0];
        },
      });
    },
    [ink, undo],
  );

  const handleErased = useCallback(
    (removed: LocalStroke[]) => {
      const ref = { current: removed };
      undo.push({
        label: removed.length === 1 ? 'erase' : `erase ${removed.length} strokes`,
        undo: () => {
          const revived = ink.restoreStrokes(ref.current);
          if (revived.length > 0) ref.current = revived;
        },
        redo: () => ink.removeStrokes(ref.current.map((s) => s.id)),
      });
    },
    [ink, undo],
  );

  const handleClear = useCallback(() => {
    const all = ink.strokes;
    if (all.length === 0) return;
    const ref = { current: all };
    void ink.clearAll();
    undo.push({
      label: 'clear ink',
      undo: () => {
        const revived = ink.restoreStrokes(ref.current);
        if (revived.length > 0) ref.current = revived;
      },
      redo: () => ink.removeStrokes(ref.current.map((s) => s.id)),
    });
  }, [ink, undo]);

  if (!open || !frame) return null;

  const activeKey = tool === 'eraser' ? 'pen' : tool;

  return (
    <>
      <div
        className="cv-noteink"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      >
        <InkSurface
          layer={ink}
          viewport={{ x: frame.offsetX, y: frame.offsetY, scale: 1 }}
          active
          tool={tool}
          color={color[activeKey]}
          width={width[activeKey]}
          fingerDraws={fingerDraws}
          onStrokeCommitted={handleStrokeCommitted}
          onErased={handleErased}
          className="cv-ink--overlay"
        />
      </div>
      <div className="cv-noteink__bar">
        <InkToolbar
          tool={tool}
          onToolChange={setTool}
          color={color[activeKey]}
          onColorChange={(c) => tool !== 'eraser' && setColor((p) => ({ ...p, [tool]: c }))}
          width={width[activeKey]}
          onWidthChange={(w) => tool !== 'eraser' && setWidth((p) => ({ ...p, [tool]: w }))}
          fingerDraws={fingerDraws}
          onFingerDrawsChange={setFingerDraws}
          onClear={handleClear}
          onClose={onClose}
        />
      </div>
    </>
  );
}
