import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Spinner } from '../Spinner';
import styles from './Button.module.css';

export type ButtonVariant = 'default' | 'primary' | 'plain' | 'destructive';
/** Control heights: sm = 24 px, md = 28 px. */
export type ControlSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /**
   * default: bordered push button; primary: accent-filled default action (Return);
   * plain: borderless toolbar button; destructive: push button with a red label.
   */
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Leading icon (e.g. a lucide icon; sized to 16 px / 14 px automatically). */
  icon?: ReactNode;
  /** Trailing icon, e.g. a chevron on a menu button. */
  trailingIcon?: ReactNode;
  /** Replaces the icon with a spinner and disables the button. */
  loading?: boolean;
  /** Stretch to the width of the container. */
  block?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  trailingIcon,
  loading = false,
  block = false,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  const hasLabel = children != null && children !== false && children !== '';
  return (
    <button
      type={type}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        block && styles.block,
        !hasLabel && (trailingIcon ? styles.iconMenu : styles.iconOnly),
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className={styles.icon}>
          <Spinner size={size === 'sm' ? 12 : 14} label="" className={styles.spinner} />
        </span>
      ) : icon ? (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      ) : null}
      {hasLabel ? <span className={styles.label}>{children}</span> : null}
      {trailingIcon ? (
        <span className={styles.trailing} aria-hidden>
          {trailingIcon}
        </span>
      ) : null}
    </button>
  );
}
