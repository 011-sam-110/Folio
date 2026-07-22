// One board item. Positioned in WORLD coordinates inside the scaled `.cv-world`
// layer, so it needs no knowledge of the viewport - the parent transform does the
// pan/zoom. The only thing that must fight that transform is the selection chrome
// (handles, outlines), which counter-scales so it stays a constant size on screen
// however far the board is zoomed.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Icon from '../../components/Icon';
import type { CanvasItem } from '../../lib/types';
import { HANDLES, type HandleId } from './items';

export interface CanvasItemViewProps {
  item: CanvasItem;
  selected: boolean;
  /** Only the single selected item shows resize + connect affordances. */
  soleSelection: boolean;
  editing: boolean;
  scale: number;
  onPointerDown: (e: ReactPointerEvent, item: CanvasItem) => void;
  onStartResize: (e: ReactPointerEvent, item: CanvasItem, handle: HandleId) => void;
  onStartConnect: (e: ReactPointerEvent, item: CanvasItem) => void;
  onStartEdit: (item: CanvasItem) => void;
  onCommitText: (item: CanvasItem, text: string) => void;
  onOpenLink: (noteId: string) => void;
}

export default function CanvasItemView({
  item,
  selected,
  soleSelection,
  editing,
  scale,
  onPointerDown,
  onStartResize,
  onStartConnect,
  onStartEdit,
  onCommitText,
  onOpenLink,
}: CanvasItemViewProps) {
  const textEditable = item.kind === 'sticky' || item.kind === 'text';

  return (
    <div
      className={`cv-item cv-item--${item.kind}${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex: item.z,
        transform: item.rotation ? `rotate(${item.rotation}deg)` : undefined,
      }}
      data-item-id={item.id}
      onPointerDown={(e) => onPointerDown(e, item)}
      onDoubleClick={(e) => {
        if (!textEditable) return;
        e.stopPropagation();
        onStartEdit(item);
      }}
    >
      <ItemBody item={item} editing={editing} onCommitText={onCommitText} onOpenLink={onOpenLink} />

      {selected && (
        // Outline is a sibling rather than a border so it never changes the item's
        // layout box - a 2px border would shift the content on selection.
        <div className="cv-item__outline" style={{ outlineWidth: 1.5 / scale, outlineOffset: 2 / scale }} aria-hidden="true" />
      )}

      {selected && soleSelection && (
        <>
          {HANDLES.map((h) => (
            <div
              key={h.id}
              className="cv-item__handle"
              style={{
                left: `${h.fx * 100}%`,
                top: `${h.fy * 100}%`,
                width: 10 / scale,
                height: 10 / scale,
                borderWidth: 1.5 / scale,
                cursor: h.cursor,
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onStartResize(e, item, h.id);
              }}
            />
          ))}
          {/* Connector handle. Sits off the right edge so it cannot be confused
              with a resize corner, and only ever appears on a single selection. */}
          <div
            className="cv-item__connect"
            style={{ width: 14 / scale, height: 14 / scale, right: -22 / scale, borderWidth: 1.5 / scale }}
            title="Drag to another item to connect"
            onPointerDown={(e) => {
              e.stopPropagation();
              onStartConnect(e, item);
            }}
          />
        </>
      )}
    </div>
  );
}

function ItemBody({
  item,
  editing,
  onCommitText,
  onOpenLink,
}: {
  item: CanvasItem;
  editing: boolean;
  onCommitText: (item: CanvasItem, text: string) => void;
  onOpenLink: (noteId: string) => void;
}) {
  switch (item.kind) {
    case 'sticky':
      return (
        <div className="cv-sticky" style={{ background: item.data.color ?? '#ffe8a3' }}>
          <TextBody item={item} editing={editing} onCommitText={onCommitText} placeholder="Double-click to write" />
        </div>
      );

    case 'text':
      return (
        <div className="cv-text">
          <TextBody item={item} editing={editing} onCommitText={onCommitText} placeholder="Double-click to write" />
        </div>
      );

    case 'shape':
      return <ShapeBody item={item} />;

    case 'image':
      return item.data.url ? (
        <img className="cv-image" src={item.data.url} alt="" draggable={false} />
      ) : (
        <div className="cv-image cv-image--missing">
          <Icon name="image" size={20} />
        </div>
      );

    case 'link':
      return (
        <button
          type="button"
          className="cv-link"
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (item.data.noteId) onOpenLink(item.data.noteId);
          }}
          // Double-click is the board convention for opening, but a button that only
          // responds to it is unusable by keyboard; Enter/Space do the same thing.
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              if (item.data.noteId) onOpenLink(item.data.noteId);
            }
          }}
          title="Double-click to open this note"
        >
          <span className="cv-link__icon">
            <Icon name="file-text" size={15} />
          </span>
          <span className="cv-link__title">{item.data.title || 'Untitled note'}</span>
          <span className="cv-link__hint">Double-click to open</span>
        </button>
      );

    default:
      return null;
  }
}

/** Shared text rendering for sticky + text items. Swaps to a textarea while
 *  editing rather than using contenteditable, which would need its own
 *  sanitisation and paste handling for no gain - board text is plain text. */
function TextBody({
  item,
  editing,
  onCommitText,
  placeholder,
}: {
  item: CanvasItem;
  editing: boolean;
  onCommitText: (item: CanvasItem, text: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(item.data.text ?? '');
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Re-seed when the item changes underneath (undo of a text edit, for instance).
  const lastExternal = useRef(item.data.text ?? '');
  useEffect(() => {
    const next = item.data.text ?? '';
    if (next !== lastExternal.current) {
      lastExternal.current = next;
      setDraft(next);
    }
  }, [item.data.text]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  if (!editing) {
    const text = item.data.text ?? '';
    return <div className={`cv-body${text ? '' : ' is-empty'}`}>{text || placeholder}</div>;
  }

  return (
    <textarea
      ref={ref}
      className="cv-body cv-body--edit"
      aria-label={placeholder || 'Item text'}
      value={draft}
      placeholder={placeholder}
      // Stop the board's marquee/drag and its keyboard shortcuts from seeing the
      // events that belong to this textarea.
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCommitText(item, draft);
        }
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommitText(item, draft)}
    />
  );
}

function ShapeBody({ item }: { item: CanvasItem }) {
  const color = item.data.color ?? '#4f46e5';
  const shape = item.data.shape ?? 'rect';
  // A 0-0-w-h viewBox with non-scaling strokes keeps the outline an even weight
  // whatever the item's aspect ratio has been dragged to.
  const w = Math.max(1, item.width);
  const h = Math.max(1, item.height);
  const inset = 2;
  return (
    <svg className="cv-shape" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {shape === 'rect' && (
        <rect
          x={inset}
          y={inset}
          width={Math.max(1, w - inset * 2)}
          height={Math.max(1, h - inset * 2)}
          rx={10}
          fill={`${color}1f`}
          stroke={color}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {shape === 'ellipse' && (
        <ellipse
          cx={w / 2}
          cy={h / 2}
          rx={Math.max(1, w / 2 - inset)}
          ry={Math.max(1, h / 2 - inset)}
          fill={`${color}1f`}
          stroke={color}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {shape === 'arrow' && (
        <g stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
          <line x1={inset} y1={h / 2} x2={w - 14} y2={h / 2} />
          <polyline points={`${w - 20},${h / 2 - 9} ${w - inset},${h / 2} ${w - 20},${h / 2 + 9}`} />
        </g>
      )}
    </svg>
  );
}
