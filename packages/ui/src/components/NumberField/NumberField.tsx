import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cx } from '../../lib/cx';
import { mergeRefs } from '../../lib/mergeRefs';
import { TextField, type TextFieldProps } from '../TextField';
import { decimalsOf, formatNumberValue, normalizeNumber, parseNumberInput, stepNumber } from './number';
import styles from './NumberField.module.css';

export interface NumberFieldProps
  extends Omit<
    TextFieldProps,
    'value' | 'defaultValue' | 'onChange' | 'onValueChange' | 'type' | 'trailing' | 'min' | 'max' | 'step'
  > {
  value: number | null;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  /** Arrow keys / stepper increment (default 1). Shift+arrow uses `largeStep` (default 10 × step). */
  step?: number;
  largeStep?: number;
  /** Decimal places (default: those of `step`). */
  precision?: number;
  /** Unit shown inside the field after the number ("bp", "°C", "nM"). */
  unit?: ReactNode;
  /** Show the stepper arrows (default true). */
  stepper?: boolean;
  /** Allow an empty field (value null). Otherwise clearing the text reverts. */
  allowEmpty?: boolean;
}

const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 60;

/**
 * Numeric field with unit suffix and a stepper. Commits on Return or blur (Esc reverts);
 * ↑/↓ step (Shift ×10). Accepts "1,256", "1256 bp", "−5".
 */
export function NumberField({
  value,
  onValueChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  largeStep,
  precision,
  unit,
  stepper = true,
  allowEmpty = false,
  size = 'md',
  disabled,
  className,
  width,
  onKeyDown,
  onBlur,
  ref,
  ...rest
}: NumberFieldProps) {
  const decimals = precision ?? decimalsOf(step);
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const setRef = useMemo(() => mergeRefs(inputRef, ref), [ref]);
  const repeat = useRef<{ timer: number | undefined }>({ timer: undefined });
  const onValueChangeRef = useRef(onValueChange);
  useEffect(() => {
    onValueChangeRef.current = onValueChange;
  });

  const display = draft ?? (value === null ? '' : formatNumberValue(value, decimals));

  const commit = () => {
    if (draft === null) return;
    const parsed = parseNumberInput(draft);
    setDraft(null);
    if (parsed === null) {
      if (allowEmpty && draft.trim() === '' && value !== null) onValueChange(null);
      return;
    }
    const next = normalizeNumber(parsed, min, max, decimals);
    if (next !== value) onValueChange(next);
  };

  const stepBy = (direction: 1 | -1, big: boolean) => {
    const current = draft !== null ? (parseNumberInput(draft) ?? value) : value;
    const s = big ? (largeStep ?? step * 10) : step;
    const next = stepNumber(current, direction, s, min, max, decimals);
    setDraft(null);
    if (next !== value) onValueChange(next);
    return next;
  };

  const stopRepeat = () => {
    window.clearTimeout(repeat.current.timer);
    window.clearInterval(repeat.current.timer);
    repeat.current.timer = undefined;
  };
  useEffect(() => stopRepeat, []);

  const startRepeat = (direction: 1 | -1) => {
    stopRepeat();
    stepBy(direction, false);
    repeat.current.timer = window.setTimeout(() => {
      repeat.current.timer = window.setInterval(() => {
        // read the latest value through the input (state updates are async)
        const el = inputRef.current;
        const current = el ? parseNumberInput(el.value) : null;
        const next = stepNumber(current, direction, step, min, max, decimals);
        onValueChangeRef.current(next);
      }, REPEAT_INTERVAL);
    }, REPEAT_DELAY);
  };

  return (
    <span className={cx(styles.root, className)} style={width !== undefined ? { width } : undefined}>
      <TextField
        {...rest}
        ref={setRef}
        size={size}
        disabled={disabled}
        inputMode="decimal"
        role="spinbutton"
        autoComplete="off"
        aria-valuenow={value ?? undefined}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        aria-valuetext={value === null ? undefined : `${formatNumberValue(value, decimals)}${typeof unit === 'string' ? ` ${unit}` : ''}`}
        value={display}
        className={styles.field}
        trailing={unit != null ? <span className={styles.unit}>{unit}</span> : undefined}
        onValueChange={(text) => setDraft(text)}
        onBlur={(e) => {
          commit();
          onBlur?.(e);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            stepBy(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            commit();
          } else if (e.key === 'Escape' && draft !== null) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
      {stepper ? (
        <span className={cx(styles.stepper, styles[size], disabled && styles.disabled)} aria-hidden>
          {([1, -1] as const).map((dir) => (
            <span
              key={dir}
              className={styles.stepButton}
              data-direction={dir > 0 ? 'up' : 'down'}
              onPointerDown={(e) => {
                if (disabled || e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                startRepeat(dir);
              }}
              onPointerUp={stopRepeat}
              onPointerCancel={stopRepeat}
              onLostPointerCapture={stopRepeat}
            >
              {dir > 0 ? <ChevronUp /> : <ChevronDown />}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
