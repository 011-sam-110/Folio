// Connector layer. Lives INSIDE the scaled world, drawing in world coordinates,
// which is what makes connectors re-route for free: every endpoint is recomputed
// from the items' live rects on each render, so moving a card moves its arrows in
// the same frame with no stored routing to invalidate.

import type { CanvasEdge, CanvasItem } from '../../lib/types';
import { borderPoint, centerOf, rectOf, type Point } from './geometry';

export interface ConnectorsProps {
  items: readonly CanvasItem[];
  edges: readonly CanvasEdge[];
  selectedEdgeId: string | null;
  onSelectEdge: (id: string | null) => void;
  scale: number;
  /** The rubber-band line while dragging a new connector out of an item. */
  pending: { from: CanvasItem; to: Point } | null;
}

export default function Connectors({ items, edges, selectedEdgeId, onSelectEdge, scale, pending }: ConnectorsProps) {
  const byId = new Map(items.map((i) => [i.id, i]));
  // Arrowheads and hit areas are specified in screen pixels and divided by the
  // scale, so they stay the same physical size at any zoom.
  const head = 11 / scale;
  const hit = 14 / scale;

  return (
    // A 1x1 SVG with visible overflow: the board is unbounded, so there is no
    // sensible finite viewBox. Children are placed at raw world coordinates.
    <svg className="cv-edges" width="1" height="1" style={{ overflow: 'visible' }} aria-hidden="true">
      {edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        // An edge whose endpoint has been deleted locally but whose cascade has
        // not been reflected yet simply does not render.
        if (!from || !to) return null;
        const a = borderPoint(rectOf(from), centerOf(rectOf(to)));
        const b = borderPoint(rectOf(to), centerOf(rectOf(from)));
        const selected = edge.id === selectedEdgeId;
        return (
          <g key={edge.id} className={`cv-edge${selected ? ' is-selected' : ''}`}>
            {/* Invisible fat line purely for hit-testing - a 1.5px arrow is
                essentially impossible to click otherwise. */}
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="transparent"
              strokeWidth={hit}
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelectEdge(edge.id);
              }}
            />
            <line
              className="cv-edge__line"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              strokeWidth={selected ? 2.5 : 1.75}
              strokeDasharray={edge.style === 'dashed' ? `${6 / scale} ${5 / scale}` : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {edge.style !== 'line' && <ArrowHead at={b} from={a} size={head} className="cv-edge__head" />}
          </g>
        );
      })}

      {pending && (
        <g className="cv-edge cv-edge--pending">
          {(() => {
            const a = borderPoint(rectOf(pending.from), pending.to);
            return (
              <>
                <line className="cv-edge__line" x1={a.x} y1={a.y} x2={pending.to.x} y2={pending.to.y} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
                <ArrowHead at={pending.to} from={a} size={head} className="cv-edge__head" />
              </>
            );
          })()}
        </g>
      )}
    </svg>
  );
}

/** Two short strokes forming a V at `at`, opening back toward `from`. */
function ArrowHead({ at, from, size, className }: { at: Point; from: Point; size: number; className?: string }) {
  const angle = Math.atan2(at.y - from.y, at.x - from.x);
  const spread = 0.45; // radians either side - a ~26° half-angle reads as a clean arrow
  const p1 = { x: at.x - size * Math.cos(angle - spread), y: at.y - size * Math.sin(angle - spread) };
  const p2 = { x: at.x - size * Math.cos(angle + spread), y: at.y - size * Math.sin(angle + spread) };
  return (
    <polyline
      className={className}
      points={`${p1.x},${p1.y} ${at.x},${at.y} ${p2.x},${p2.y}`}
      fill="none"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}
