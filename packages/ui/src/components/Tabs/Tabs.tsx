import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import styles from './Tabs.module.css';

/** Root: `value` / `defaultValue` / `onValueChange`. */
export function Tabs({ className, ...rest }: ComponentPropsWithRef<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cx(styles.root, className)} {...rest} />;
}

export function TabsList({ className, ...rest }: ComponentPropsWithRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cx(styles.list, className)} {...rest} />;
}

export interface TabsTriggerProps extends ComponentPropsWithRef<typeof TabsPrimitive.Trigger> {
  icon?: ReactNode;
}

/** Inspector-style tab: quiet text (and/or icon); the selected tab sits on a soft pill. */
export function TabsTrigger({ icon, className, children, ...rest }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger className={cx(styles.trigger, className)} {...rest}>
      {icon ? (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      ) : null}
      {children != null ? <span className={styles.label}>{children}</span> : null}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...rest }: ComponentPropsWithRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cx(styles.content, className)} {...rest} />;
}
