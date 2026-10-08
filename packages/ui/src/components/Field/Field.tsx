import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Field.module.css';

export interface FieldProps {
  label: ReactNode;
  /** The control. Gets an id (if it has none) and aria-describedby for hint/error. */
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; invalid?: boolean }>;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text under the control (replaces the hint, marks the control invalid). */
  error?: ReactNode;
  /** stacked: label above (default); inline: label in a right-aligned column on the left (macOS forms). */
  layout?: 'stacked' | 'inline';
  /** Width of the label column in inline layout (px, default 120). */
  labelWidth?: number;
  className?: string;
}

/** A labelled form row: label + control + hint/error, with the accessibility wiring done. */
export function Field({ label, children, hint, error, layout = 'stacked', labelWidth = 120, className }: FieldProps) {
  const autoId = useId();
  const controlId = (isValidElement(children) && children.props.id) || `${autoId}-control`;
  const noteId = `${autoId}-note`;
  const note = error ?? hint;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        'aria-describedby': cx(children.props['aria-describedby'], note ? noteId : undefined) || undefined,
        ...(error ? { invalid: true } : {}),
      })
    : children;
  return (
    <div
      className={cx(styles.field, layout === 'inline' ? styles.inline : styles.stacked, className)}
      style={layout === 'inline' ? { gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` } : undefined}
    >
      <label htmlFor={controlId} className={styles.label}>
        {label}
      </label>
      <div className={styles.control}>
        {control}
        {note ? (
          <div id={noteId} className={cx(styles.note, error ? styles.error : undefined)}>
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}
