import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { RadioGroup } from 'radix-ui';
import { cx } from '../../lib/cx';
import type { ControlSize } from '../Button';
import { Tooltip } from '../Tooltip';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string = string> {
  value: T;
  /** Visible text (also the accessible name and the tooltip in icon-only mode). */
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Tooltip; defaults to the label when the control shows icons only. */
  tooltip?: string;
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name of the group, e.g. "View". */
  'aria-label': string;
  size?: ControlSize;
  /** Show icons only (labels move to tooltips and accessible names). */
  iconOnly?: boolean;
  /** Stretch to the container width with equal-width segments. */
  fill?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}

interface ThumbRect {
  left: number;
  width: number;
}

/**
 * macOS segmented control for choosing one of a few options (radio-group semantics:
 * Tab focuses the selected segment, arrow keys move and select).
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  size = 'md',
  iconOnly = false,
  fill = false,
  disabled,
  className,
  id,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<ThumbRect | null>(null);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>('[data-segment][aria-checked="true"]');
      if (!el) {
        setThumb(null);
        return;
      }
      const next = { left: el.offsetLeft, width: el.offsetWidth };
      setThumb((prev) => (prev && prev.left === next.left && prev.width === next.width ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const child of Array.from(root.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [value, options, size, iconOnly, fill]);

  // Enable the sliding animation only after the first measurement (no slide-in on mount).
  useEffect(() => {
    if (!thumb || animate) return;
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [thumb, animate]);

  /**
   * Arrow keys / Home / End move to a segment AND choose it (radio-group pattern). Radix
   * selects on the focus that follows a key press only while the key is still held, which
   * misses quick taps; handling the keys here makes the choice deterministic.
   */
  const onItemKeyDown = (e: KeyboardEvent<HTMLButtonElement>, from: T) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || disabled) return;
    const enabled = options.filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const index = enabled.findIndex((o) => o.value === from);
    let next: SegmentedOption<T> | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(index + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault(); // also skips Radix's own roving-focus handling of this key
    const target = next.value;
    const segments = rootRef.current?.querySelectorAll<HTMLElement>('[data-segment]') ?? [];
    for (const el of segments) if (el.dataset.value === target) el.focus();
    if (target !== value) onValueChange(target);
  };

  return (
    <RadioGroup.Root
      ref={rootRef}
      id={id}
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      orientation="horizontal"
      loop
      disabled={disabled}
      aria-label={ariaLabel}
      data-tauri-drag-region="false"
      className={cx(styles.root, styles[size], fill && styles.fill, iconOnly && styles.iconOnly, className)}
    >
      {thumb ? (
        <span
          aria-hidden
          className={cx(styles.thumb, animate && styles.animated)}
          style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
        />
      ) : null}
      {options.map((opt) => {
        const item = (
          <RadioGroup.Item
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            data-segment=""
            data-value={opt.value}
            aria-label={iconOnly || !opt.label ? opt.label : undefined}
            className={styles.item}
            onKeyDown={(e) => onItemKeyDown(e, opt.value)}
          >
            {opt.icon ? (
              <span className={styles.icon} aria-hidden>
                {opt.icon}
              </span>
            ) : null}
            {!iconOnly || !opt.icon ? <span className={styles.label}>{opt.label}</span> : null}
          </RadioGroup.Item>
        );
        const tip = opt.tooltip ?? (iconOnly ? opt.label : undefined);
        return tip ? (
          <Tooltip key={opt.value} content={tip} shortcut={opt.shortcut}>
            {item}
          </Tooltip>
        ) : (
          item
        );
      })}
    </RadioGroup.Root>
  );
}
