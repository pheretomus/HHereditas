import { useMemo, useRef, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { mergeRefs } from '../../lib/mergeRefs';
import type { ControlSize } from '../Button';
import styles from './TextField.module.css';

export interface TextFieldProps extends Omit<ComponentPropsWithRef<'input'>, 'size' | 'prefix' | 'width'> {
  size?: ControlSize;
  /** Red outline and aria-invalid. */
  invalid?: boolean;
  /** Content inside the field before the text (icon). */
  leading?: ReactNode;
  /** Content inside the field after the text (unit, small button). */
  trailing?: ReactNode;
  /** Receives the new string value on every edit (in addition to onChange). */
  onValueChange?: (value: string) => void;
  /** Monospaced text, e.g. for sequences and coordinates. */
  mono?: boolean;
  /** Width of the field (px or CSS length). Default: fills the available width. */
  width?: number | string;
  /** Class name of the outer frame (className goes there too). */
  className?: string;
}

/** Single-line text input in the macOS style: white field, hairline border, accent focus ring. */
export function TextField({
  size = 'md',
  invalid = false,
  leading,
  trailing,
  onValueChange,
  onChange,
  mono = false,
  width,
  className,
  style,
  disabled,
  ref,
  ...rest
}: TextFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setRef = useMemo(() => mergeRefs(inputRef, ref), [ref]);
  return (
    <span
      className={cx(styles.field, styles[size], invalid && styles.invalid, disabled && styles.disabled, className)}
      style={width !== undefined ? { width, ...style } : style}
      onPointerDown={(e) => {
        // Clicking the frame or an adornment focuses the input, like a native field.
        if (e.target instanceof HTMLElement && !e.target.closest('button, input, a, [role="button"]')) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <input
        ref={setRef}
        className={cx(styles.input, mono && styles.mono)}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        spellCheck={mono ? false : rest.spellCheck}
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
        {...rest}
      />
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </span>
  );
}
