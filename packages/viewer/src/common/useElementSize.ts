import { type RefObject, useLayoutEffect, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/** Whether the element is hidden by `visibility` (a pane collapsed behind another tab, say). */
function isHidden(el: Element): boolean {
  return typeof getComputedStyle === 'function' && getComputedStyle(el).visibility === 'hidden';
}

/**
 * Tracks the content-box size of an element with ResizeObserver. Visualizations use it to
 * fill whatever space the layout gives them. Returns {0, 0} until the first measurement.
 *
 * A hidden element still has a box, but not the one it will be drawn in: its size is left at what it last was while
 * shown, so that it comes back laid out as it was instead of jumping from the hidden box's layout to the real one a
 * frame after it is shown again.
 */
export function useElementSize<T extends Element>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number, height: number) =>
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    if (!isHidden(el)) {
      const rect = el.getBoundingClientRect();
      update(Math.round(rect.width), Math.round(rect.height));
    }
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && !isHidden(el)) update(Math.round(box.width), Math.round(box.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
