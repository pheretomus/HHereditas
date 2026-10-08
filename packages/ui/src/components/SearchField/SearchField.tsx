import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { CircleX, Search } from 'lucide-react';
import { cx } from '../../lib/cx';
import { mergeRefs } from '../../lib/mergeRefs';
import { useControllableState } from '../../lib/useControllableState';
import { TextField, type TextFieldProps } from '../TextField';
import styles from './SearchField.module.css';

export interface SearchFieldProps
  extends Omit<TextFieldProps, 'leading' | 'trailing' | 'type' | 'value' | 'defaultValue' | 'onSubmit'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Return (direction "next") or Shift+Return ("previous"). */
  onSubmit?: (value: string, direction: 'next' | 'previous') => void;
  /** Called after the field was cleared with the clear button or Esc. */
  onClear?: () => void;
  /** Short status shown before the clear button, e.g. "3 of 12". */
  status?: ReactNode;
}

/**
 * Search field with a magnifier and a clear button. Esc clears the text. Inside a Toolbar it
 * takes the borderless, tinted toolbar appearance automatically.
 */
export function SearchField({
  value,
  defaultValue = '',
  onValueChange,
  onSubmit,
  onClear,
  status,
  placeholder = 'Search',
  className,
  onKeyDown,
  ref,
  'aria-label': ariaLabel,
  ...rest
}: SearchFieldProps) {
  const [text, setText] = useControllableState(value, defaultValue, onValueChange);
  const inputRef = useRef<HTMLInputElement>(null);
  const setRef = useMemo(() => mergeRefs(inputRef, ref), [ref]);

  const clear = () => {
    setText('');
    onClear?.();
    inputRef.current?.focus();
  };

  return (
    <TextField
      {...rest}
      ref={setRef}
      type="search"
      role="searchbox"
      aria-label={ariaLabel ?? placeholder}
      placeholder={placeholder}
      value={text}
      onValueChange={setText}
      className={cx(styles.search, className)}
      leading={<Search className={styles.magnifier} aria-hidden />}
      trailing={
        status != null || text ? (
          <>
            {status != null ? <span className={styles.status}>{status}</span> : null}
            {text ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label="Clear search"
                className={styles.clear}
                onPointerDown={(e) => e.preventDefault()}
                onClick={clear}
              >
                <CircleX aria-hidden />
              </button>
            ) : null}
          </>
        ) : undefined
      }
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Escape' && text) {
          e.preventDefault();
          e.stopPropagation();
          clear();
        } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          onSubmit?.(text, e.shiftKey ? 'previous' : 'next');
        }
      }}
    />
  );
}
