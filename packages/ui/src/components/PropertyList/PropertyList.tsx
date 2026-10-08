import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cx } from '../../lib/cx';
import styles from './PropertyList.module.css';

export interface PropertyItem {
  label: ReactNode;
  value: ReactNode;
  /** Text put on the clipboard by the copy button (default: the value when it is a string or number). */
  copyValue?: string;
  /** Monospaced value (sequences, coordinates). */
  mono?: boolean;
  /** Native tooltip on the value (e.g. the untruncated text). */
  title?: string;
  /** React key (default: the label when it is a string). */
  key?: string;
}

export interface PropertyListProps {
  items?: readonly PropertyItem[];
  /** PropertyRow elements (alternative to `items`). */
  children?: ReactNode;
  /** Width of the label column in px (default 88). */
  labelWidth?: number;
  /** Show copy buttons on hover (default true). */
  copyable?: boolean;
  className?: string;
  style?: CSSProperties;
}

const Ctx = createContext({ copyable: true });

/** Label/value rows for inspectors: right-aligned labels, selectable values with a copy button. */
export function PropertyList({ items, children, labelWidth = 88, copyable = true, className, style }: PropertyListProps) {
  return (
    <Ctx.Provider value={{ copyable }}>
      <dl className={cx(styles.list, className)} style={{ ['--_label' as string]: `${labelWidth}px`, ...style }}>
        {items?.map((item, i) => (
          <PropertyRow
            key={item.key ?? (typeof item.label === 'string' ? item.label : i)}
            label={item.label}
            copyValue={item.copyValue}
            mono={item.mono}
            title={item.title}
          >
            {item.value}
          </PropertyRow>
        ))}
        {children}
      </dl>
    </Ctx.Provider>
  );
}

export interface PropertyRowProps {
  label: ReactNode;
  children: ReactNode;
  copyValue?: string;
  mono?: boolean;
  title?: string;
  /** Override the list's copyable setting for this row. */
  copyable?: boolean;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function PropertyRow({ label, children, copyValue, mono = false, title, copyable }: PropertyRowProps) {
  const ctx = useContext(Ctx);
  const text = copyValue ?? (typeof children === 'string' || typeof children === 'number' ? String(children) : undefined);
  const canCopy = (copyable ?? ctx.copyable) && text !== undefined && text !== '';
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={cx(styles.value, mono && styles.mono)} title={title}>
        <span className={styles.valueText}>{children}</span>
        {canCopy ? (
          <button
            type="button"
            className={cx(styles.copy, copied && styles.copied)}
            aria-label={copied ? 'Copied' : `Copy ${typeof label === 'string' ? label : 'value'}`}
            onClick={async () => {
              if (await writeClipboard(text!)) {
                setCopied(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopied(false), 1200);
              }
            }}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </button>
        ) : null}
      </dd>
    </div>
  );
}
