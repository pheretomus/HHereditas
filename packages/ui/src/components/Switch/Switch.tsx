import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import type { ControlSize } from '../Button';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<ComponentPropsWithRef<typeof SwitchPrimitive.Root>, 'children'> {
  /** Text next to the switch (clicking it toggles). Without a label, pass aria-label. */
  label?: ReactNode;
  /** Put the label before the switch (settings rows) instead of after it. */
  labelPosition?: 'start' | 'end';
  size?: ControlSize;
}

/** macOS on/off switch. */
export function Switch({ label, labelPosition = 'end', size = 'md', className, disabled, ...rest }: SwitchProps) {
  const control = (
    <SwitchPrimitive.Root className={cx(styles.track, styles[size], !label && className)} disabled={disabled} {...rest}>
      <SwitchPrimitive.Thumb className={styles.thumb} />
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    <label className={cx(styles.wrapper, labelPosition === 'start' && styles.start, disabled && styles.disabled, className)}>
      {labelPosition === 'start' ? <span className={styles.label}>{label}</span> : null}
      {control}
      {labelPosition === 'end' ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
}
