import { type RefObject, useLayoutEffect, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Tracks the content-box size of an element with ResizeObserver. Visualizations use it to
 * fill whatever space the layout gives them. Returns {0, 0} until the first measurement.
 */
export function useElementSize<T extends Element>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number, height: number) =>
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    const rect = el.getBoundingClientRect();
    update(Math.round(rect.width), Math.round(rect.height));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) update(Math.round(box.width), Math.round(box.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
