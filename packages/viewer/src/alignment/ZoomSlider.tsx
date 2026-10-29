/**
 * Vertical slider drawn as a rounded tube: the knob slides inside the tube and the fill below it rises with it.
 * Clicks on the tube glide the knob to the spot; dragging follows the pointer directly. Arrow keys, Page keys and
 * Home / End work as on a native slider.
 */
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useRef, useState } from 'react';
import styles from './ZoomSlider.module.css';

export interface ZoomSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  'aria-label': string;
  /** Height of the tube (px). */
  height?: number;
}

export function ZoomSlider(props: ZoomSliderProps) {
  const { value, min, max, step, onChange, height = 52 } = props;
  const tube = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  const fraction = (Math.max(min, Math.min(max, value)) - min) / (max - min || 1);

  const valueAt = (clientY: number): number => {
    const box = tube.current?.getBoundingClientRect();
    if (!box || box.height <= 0) return value;
    return clamp(min + (1 - (clientY - box.top) / box.height) * (max - min));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(valueAt(e.clientY));
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) onChange(valueAt(e.clientY));
  };
  const stop = () => setDragging(false);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const big = (max - min) / 5;
    const next =
      e.key === 'ArrowUp' || e.key === 'ArrowRight'
        ? value + step
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
          ? value - step
          : e.key === 'PageUp'
            ? value + big
            : e.key === 'PageDown'
              ? value - big
              : e.key === 'Home'
                ? min
                : e.key === 'End'
                  ? max
                  : null;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(next));
  };

  return (
    <div
      ref={tube}
      className={[styles.tube, dragging ? styles.dragging : ''].filter(Boolean).join(' ')}
      style={{ height }}
      role="slider"
      tabIndex={0}
      aria-label={props['aria-label']}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 10) / 10}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    >
      <div className={styles.fill} style={{ height: `calc(${fraction} * (100% - var(--knob)) + var(--knob) / 2)` }} />
      <div className={styles.knob} style={{ bottom: `calc(${fraction} * (100% - var(--knob)))` }} />
    </div>
  );
}
