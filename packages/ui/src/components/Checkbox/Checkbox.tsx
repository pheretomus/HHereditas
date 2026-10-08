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

/**
 * macOS checkbox: `checked` may be true, false or 'indeterminate'. With a `label`,
 * `className` and `style` apply to the labelled row.
 */
export function Checkbox({ label, description, className, style, disabled, ...rest }: CheckboxProps) {
  const labelled = label != null && label !== false && label !== '';
  const box = (
    <CheckboxPrimitive.Root
      className={cx(styles.box, !labelled && className)}
      style={labelled ? undefined : style}
      disabled={disabled}
      {...rest}
    >
      <CheckboxPrimitive.Indicator className={styles.indicator}>
        <Check className={styles.check} aria-hidden />
        <Minus className={styles.dash} aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!labelled) return box;
  return (
    <label className={cx(styles.wrapper, disabled && styles.disabled, className)} style={style}>
      {box}
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
    </label>
  );
}
