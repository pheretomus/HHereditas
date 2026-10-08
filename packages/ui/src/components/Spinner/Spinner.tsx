import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../lib/cx';
import styles from './Spinner.module.css';

export interface SpinnerProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  /** Diameter in px (default 16). */
  size?: number;
  /** Accessible name (default "Loading"). Pass an empty string for a purely decorative spinner. */
  label?: string;
}

const SPOKES = 8;

/** macOS-style indeterminate activity indicator (eight fading spokes, stepping rotation). */
export function Spinner({ size = 16, label = 'Loading', className, style, ...rest }: SpinnerProps) {
  const decorative = label === '';
  return (
    <span
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      className={cx(styles.spinner, className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} className={styles.svg} aria-hidden>
        {Array.from({ length: SPOKES }, (_, i) => (
          <line
            key={i}
            x1="12"
            y1="3.2"
            x2="12"
            y2="7.4"
            className={styles.spoke}
            style={{ opacity: 0.18 + (0.82 * (i + 1)) / SPOKES }}
            transform={`rotate(${(i * 360) / SPOKES} 12 12)`}
          />
        ))}
      </svg>
    </span>
  );
}
