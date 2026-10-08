import type { CSSProperties } from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import type { ControlSize } from '../Button';
import styles from './Slider.module.css';

export interface SliderProps {
  value?: number;
  defaultValue?: number;
  /** Called continuously while dragging. */
  onValueChange?: (value: number) => void;
  /** Called once when the user finishes a change (pointer up / key). */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Number of evenly spaced tick marks under the track (0 = none). */
  ticks?: number;
  size?: ControlSize;
  disabled?: boolean;
  'aria-label'?: string;
  /** Spoken value, e.g. (v) => `${v} %`. */
  getValueText?: (value: number) => string;
  id?: string;
  className?: string;
  style?: CSSProperties;
}

/** macOS slider: thin track with an accent fill and a round white knob. */
export function Slider({
  value,
  defaultValue,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  ticks = 0,
  size = 'md',
  disabled,
  getValueText,
  id,
  className,
  style,
  'aria-label': ariaLabel,
}: SliderProps) {
  const current = value ?? defaultValue ?? min;
  return (
    <SliderPrimitive.Root
      id={id}
      value={value === undefined ? undefined : [value]}
      defaultValue={defaultValue === undefined ? undefined : [defaultValue]}
      onValueChange={onValueChange ? (v) => onValueChange(v[0]) : undefined}
      onValueCommit={onValueCommit ? (v) => onValueCommit(v[0]) : undefined}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cx(styles.root, styles[size], ticks > 1 && styles.withTicks, className)}
      style={style}
    >
      <SliderPrimitive.Track className={styles.track}>
        <SliderPrimitive.Range className={styles.range} />
      </SliderPrimitive.Track>
      {ticks > 1 ? (
        <span className={styles.ticks} aria-hidden>
          {Array.from({ length: ticks }, (_, i) => (
            <span key={i} className={styles.tick} style={{ left: `${(i / (ticks - 1)) * 100}%` }} />
          ))}
        </span>
      ) : null}
      <SliderPrimitive.Thumb
        className={styles.thumb}
        aria-label={ariaLabel}
        aria-valuetext={getValueText ? getValueText(current) : undefined}
      />
    </SliderPrimitive.Root>
  );
}
