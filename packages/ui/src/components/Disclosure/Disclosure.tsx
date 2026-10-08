import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { cx } from '../../lib/cx';
import styles from './Disclosure.module.css';

export interface DisclosureProps {
  title: ReactNode;
  children?: ReactNode;
  open?: boolean;
  /** Default true. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Controls at the trailing end of the header (small icon buttons, a badge…). Not part of the toggle. */
  actions?: ReactNode;
  /**
   * section: inspector card with a bold title and a hairline above (default);
   * plain: inline disclosure triangle + label, no separators.
   */
  variant?: 'section' | 'plain';
  className?: string;
  id?: string;
}

/** Collapsible section with an animated disclosure chevron. */
export function Disclosure({
  title,
  children,
  open,
  defaultOpen = true,
  onOpenChange,
  actions,
  variant = 'section',
  className,
  id,
}: DisclosureProps) {
  return (
    <Collapsible.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      className={cx(styles.root, styles[variant], className)}
      id={id}
    >
      <div className={styles.header}>
        <Collapsible.Trigger className={styles.trigger}>
          <ChevronRight className={styles.chevron} aria-hidden />
          <span className={styles.title}>{title}</span>
        </Collapsible.Trigger>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      <Collapsible.Content className={styles.content}>
        <div className={styles.inner}>{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
