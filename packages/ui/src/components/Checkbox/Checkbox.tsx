import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<ComponentPropsWithRef<typeof CheckboxPrimitive.Root>, 'children'> {
  /** Text next to the box (clicking it toggles). Without a label, pass aria-label. */
  label?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
}

/** macOS checkbox: `checked` may be true, false or 'indeterminate'. */
export function Checkbox({ label, description, className, disabled, ...rest }: CheckboxProps) {
  const box = (
    <CheckboxPrimitive.Root className={cx(styles.box, !label && className)} disabled={disabled} {...rest}>
      <CheckboxPrimitive.Indicator className={styles.indicator}>
        <Check className={styles.check} aria-hidden />
        <Minus className={styles.dash} aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label) return box;
  return (
    <label className={cx(styles.wrapper, disabled && styles.disabled, className)}>
      {box}
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
    </label>
  );
}
