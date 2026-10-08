import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import type { ControlSize } from '../Button';
import { Tooltip } from '../Tooltip';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** The icon (a lucide icon is sized to 16 px, or 14 px for size="sm"). */
  icon: ReactNode;
  /** Required: icon-only buttons need an accessible name. Also the default tooltip. */
  'aria-label': string;
  /** plain: borderless toolbar style (default); default: bordered push-button style. */
  variant?: 'plain' | 'default';
  size?: ControlSize;
  /**
   * Toggle state for on/off buttons (e.g. "Show Inspector"). Sets aria-pressed and tints
   * the icon with the accent colour while on.
   */
  pressed?: boolean;
  /** Tooltip text; defaults to the aria-label. Pass false for no tooltip. */
  tooltip?: ReactNode | false;
  /** Keyboard shortcut shown in the tooltip ("Mod+Alt+I"). */
  shortcut?: string;
}

/** Square, icon-only button: toolbar items, inline actions. */
export function IconButton({
  icon,
  variant = 'plain',
  size = 'md',
  pressed,
  tooltip,
  shortcut,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      className={cx(styles.button, styles[variant], styles[size], className)}
      aria-pressed={pressed}
      {...rest}
    >
      <span className={styles.icon} aria-hidden>
        {icon}
      </span>
    </button>
  );
  if (tooltip === false) return button;
  return (
    <Tooltip content={tooltip ?? rest['aria-label']} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
}
