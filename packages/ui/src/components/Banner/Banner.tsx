import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { cx } from '../../lib/cx';
import styles from './Banner.module.css';

export type BannerTone = 'info' | 'success' | 'warning' | 'error';

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  /** Message text. */
  children?: ReactNode;
  /** Buttons at the trailing end (small plain buttons work best). */
  actions?: ReactNode;
  /** Shows a close button. */
  onDismiss?: () => void;
  /** Custom icon, or false for none. */
  icon?: ReactNode | false;
  className?: string;
}

const ICONS: Record<BannerTone, ReactNode> = {
  info: <Info />,
  success: <CircleCheck />,
  warning: <TriangleAlert />,
  error: <CircleAlert />,
};

/** Inline message strip: info, success, warning or error. */
export function Banner({ tone = 'info', title, children, actions, onDismiss, icon, className }: BannerProps) {
  return (
    <div role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'} className={cx(styles.banner, styles[tone], className)}>
      {icon === false ? null : (
        <span className={styles.icon} aria-hidden>
          {icon ?? ICONS[tone]}
        </span>
      )}
      <div className={styles.text}>
        {title ? <span className={styles.title}>{title}</span> : null}
        {children ? <span className={styles.message}>{children}</span> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {onDismiss ? (
        <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
          <X aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
