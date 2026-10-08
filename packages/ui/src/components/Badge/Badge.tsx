import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../lib/cx';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  tone?: BadgeTone;
  /** Solid fill (white text) instead of the soft tinted style. */
  solid?: boolean;
  size?: 'sm' | 'md';
}

/** Small pill for counts and short status words ("Unique", "3", "New"). */
export function Badge({ tone = 'neutral', solid = false, size = 'md', className, ...rest }: BadgeProps) {
  return <span className={cx(styles.badge, styles[tone], solid && styles.solid, styles[size], className)} {...rest} />;
}
