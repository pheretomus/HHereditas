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

/**
 * macOS on/off switch. With a `label`, `className` and `style` apply to the labelled row
 * (so `style={{ width: '100%' }}` stretches the row, not the switch).
 */
export function Switch({ label, labelPosition = 'end', size = 'md', className, style, disabled, ...rest }: SwitchProps) {
  const labelled = label != null && label !== false && label !== '';
  const control = (
    <SwitchPrimitive.Root
      className={cx(styles.track, styles[size], !labelled && className)}
      style={labelled ? undefined : style}
      disabled={disabled}
      {...rest}
    >
      <SwitchPrimitive.Thumb className={styles.thumb} />
    </SwitchPrimitive.Root>
  );
  if (!labelled) return control;
  return (
    <label
      className={cx(styles.wrapper, labelPosition === 'start' && styles.start, disabled && styles.disabled, className)}
      style={style}
    >
      {labelPosition === 'start' ? <span className={styles.label}>{label}</span> : null}
      {control}
      {labelPosition === 'end' ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
}
