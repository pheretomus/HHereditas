import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  /** 32–40 px illustration or icon. */
  icon?: ReactNode;
  title: ReactNode;
  message?: ReactNode;
  /** Buttons or links. */
  actions?: ReactNode;
  /** sm: inspector / sidebar; md: panels (default); lg: the main canvas. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Calm placeholder for empty panes: "No Selection", "No primers yet", … */
export function EmptyState({ icon, title, message, actions, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={cx(styles.root, styles[size], className)}>
      {icon ? (
        <div className={styles.icon} aria-hidden>
          {icon}
        </div>
      ) : null}
      <div className={styles.title}>{title}</div>
      {message ? <div className={styles.message}>{message}</div> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
