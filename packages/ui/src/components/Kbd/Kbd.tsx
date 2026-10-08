import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../lib/cx';
import type { Platform } from '../../lib/platform';
import { formatShortcut, shortcutKeys } from '../../lib/shortcut';
import styles from './Kbd.module.css';

export interface KbdProps extends ComponentPropsWithRef<'kbd'> {
  /**
   * Platform-neutral shortcut such as "Mod+Shift+F" (Mod = ⌘ on macOS, Ctrl elsewhere).
   * Rendered as one key cap per key. Ignored when children are given.
   */
  shortcut?: string;
  /** Override the detected platform (mainly for documentation and tests). */
  platform?: Platform;
}

/** Keyboard keys drawn as small key caps: ⇧ ⌘ F. */
export function Kbd({ shortcut, platform, className, children, ...rest }: KbdProps) {
  if (children != null || !shortcut) {
    return (
      <kbd className={cx(styles.kbd, className)} {...rest}>
        <span className={styles.key}>{children}</span>
      </kbd>
    );
  }
  const keys = shortcutKeys(shortcut, platform);
  return (
    <kbd className={cx(styles.kbd, className)} aria-label={formatShortcut(shortcut, platform)} {...rest}>
      {keys.map((k, i) => (
        <span key={i} className={styles.key} aria-hidden>
          {k}
        </span>
      ))}
    </kbd>
  );
}
