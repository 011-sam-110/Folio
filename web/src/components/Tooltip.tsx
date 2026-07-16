// Owned by web-shell. Lightweight styled tooltip (replaces native title=).
import { cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { computePosition, offset, flip, shift, autoUpdate, type Placement } from '@floating-ui/dom';

export default function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 350,
}: {
  content: ReactNode;
  /** Any single element (button, span, ...) — loosely typed since this
   *  merges handlers/ref onto whatever the caller passes in. */
  children: ReactElement;
  placement?: Placement;
  delay?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const refEl = useRef<HTMLElement | null>(null);
  const floatEl = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!open || !refEl.current || !floatEl.current) return;
    return autoUpdate(refEl.current, floatEl.current, () => {
      if (!refEl.current || !floatEl.current) return;
      computePosition(refEl.current, floatEl.current, {
        placement,
        middleware: [offset(7), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => setPos({ x, y }));
    });
  }, [open, placement]);

  function show() {
    if (!content) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }
  function hide() {
    clearTimeout(timer.current);
    setOpen(false);
  }

  // `ReactElement`'s props are untyped (`any`) here by design — this wraps
  // an arbitrary caller-supplied trigger element, so we merge event
  // handlers + a ref loosely rather than fighting variance on a generic
  // props type. Internal utility only, not a cross-agent contract surface.
  const childProps = children.props as Record<string, unknown>;
  const extraProps = {
    onMouseEnter: (e: SyntheticEvent) => {
      (childProps.onMouseEnter as ((e: SyntheticEvent) => void) | undefined)?.(e);
      show();
    },
    onMouseLeave: (e: SyntheticEvent) => {
      (childProps.onMouseLeave as ((e: SyntheticEvent) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: SyntheticEvent) => {
      (childProps.onFocus as ((e: SyntheticEvent) => void) | undefined)?.(e);
      show();
    },
    onBlur: (e: SyntheticEvent) => {
      (childProps.onBlur as ((e: SyntheticEvent) => void) | undefined)?.(e);
      hide();
    },
    ref: (el: HTMLElement | null) => {
      refEl.current = el;
    },
  };
  const trigger = cloneElement(children, extraProps);

  return (
    <>
      {trigger}
      {open &&
        content &&
        createPortal(
          <div
            ref={floatEl}
            role="tooltip"
            className="folio-tooltip"
            style={{ position: 'fixed', top: pos.y, left: pos.x }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
