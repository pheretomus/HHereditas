import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatShortcut } from '../../lib/shortcut';
import styles from './menu.module.css';

/** Shared layout of a menu row: [state gutter] [icon] label … shortcut / submenu chevron. */
export function MenuItemInner({
  icon,
  children,
  shortcut,
  submenu,
}: {
  icon?: ReactNode;
  children?: ReactNode;
  shortcut?: string;
  submenu?: boolean;
}) {
  return (
    <>
      {icon ? (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className={styles.label}>{children}</span>
      {shortcut ? (
        <span className={styles.shortcut} aria-hidden>
          {formatShortcut(shortcut)}
        </span>
      ) : null}
      {submenu ? <ChevronRight className={styles.chevron} aria-hidden /> : null}
    </>
  );
}
