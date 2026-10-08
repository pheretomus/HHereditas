import type { ComponentPropsWithRef } from 'react';
import { Separator as SeparatorPrimitive } from 'radix-ui';
import { cx } from '../../lib/cx';
import styles from './Separator.module.css';

export interface SeparatorProps extends ComponentPropsWithRef<typeof SeparatorPrimitive.Root> {
  /** Indent both ends (e.g. 16 px inside an inspector card). */
  inset?: number;
  /** Stronger line (between major regions). */
  strong?: boolean;
}

/** Hairline separator (one device pixel on Retina). Decorative by default. */
export function Separator({
  orientation = 'horizontal',
  decorative = true,
  inset,
  strong = false,
  className,
  style,
  ...rest
}: SeparatorProps) {
  const insetStyle =
    inset === undefined
      ? undefined
      : orientation === 'horizontal'
        ? { marginLeft: inset, marginRight: inset }
        : { marginTop: inset, marginBottom: inset };
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cx(styles.separator, strong && styles.strong, className)}
      style={{ ...insetStyle, ...style }}
      {...rest}
    />
  );
}
