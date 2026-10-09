import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger, cx } from '@hhereditas/ui';
import styles from './FeatureColorWell.module.css';

const SWATCH_COUNT = 16;
const HEX = /^#[0-9a-f]{6}$/;

/**
 * The feature colour palette, read from the --hh-swatch-* design tokens (hex values that
 * are written into documents). Missing tokens are skipped.
 */
export function readSwatchPalette(root: Element = document.documentElement): string[] {
  const style = getComputedStyle(root);
  const out: string[] = [];
  for (let i = 1; i <= SWATCH_COUNT; i++) {
    const value = style.getPropertyValue(`--hh-swatch-${i}`).trim().toLowerCase();
    if (HEX.test(value)) out.push(value);
  }
  return out;
}

/**
 * '#rrggbb' for a colour written as hex or as `var(--token)` whose token holds a hex value
 * (e.g. the type colour 'var(--hh-feature-cds)'); undefined otherwise.
 */
export function resolveHexColor(color: string | undefined, root: Element = document.documentElement): string | undefined {
  if (!color) return undefined;
  const text = color.trim().toLowerCase();
  if (HEX.test(text)) return text;
  const token = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(text)?.[1];
  if (!token) return undefined;
  const value = getComputedStyle(root).getPropertyValue(token).trim().toLowerCase();
  return HEX.test(value) ? value : undefined;
}

export interface FeatureColorWellProps {
  /** The feature's own colour ('#rrggbb'); undefined when it uses its type's colour. */
  value?: string;
  /** CSS colour shown for the automatic (type) colour. */
  automaticColor: string;
  /**
   * New colour, or null for "back to the type colour". Called once per choice: a palette
   * chip, Automatic, or the system colour panel when it is closed. Omit for a read-only well.
   */
  onChange?: (color: string | null) => void;
  /** Live colour while the user drags in the system colour panel (not committed yet). */
  onPreview?: (color: string) => void;
  /** Palette override (default: the --hh-swatch-* tokens). */
  palette?: readonly string[];
  'aria-label'?: string;
  /** Element id of the visible label (for aria-labelledby). */
  'aria-labelledby'?: string;
}

/** macOS-style colour well: a swatch button that opens a small palette popover. */
export function FeatureColorWell({
  value,
  automaticColor,
  onChange,
  onPreview,
  palette,
  'aria-label': ariaLabel = 'Colour',
  'aria-labelledby': labelledBy,
}: FeatureColorWellProps) {
  const [open, setOpen] = useState(false);
  const [colors, setColors] = useState<readonly string[]>(() => palette ?? []);
  /** Where the system colour panel starts: the current colour, resolved to hex. */
  const [pickerStart, setPickerStart] = useState<string | undefined>(undefined);
  /** Colour being chosen in the system panel, until it is committed. */
  const [preview, setPreview] = useState<string | null>(null);
  const customId = useId();
  const valueId = useId();
  const current = value?.toLowerCase();
  const shown = preview ?? value ?? automaticColor;

  const latest = useRef({ onChange, current, preview });
  useEffect(() => {
    latest.current = { onChange, current, preview };
  });

  const commitPreview = useCallback(() => {
    const { onChange: commit, current: now, preview: next } = latest.current;
    latest.current.preview = null;
    setPreview(null);
    if (next && next !== now) commit?.(next);
  }, []);

  // The native input's `change` event fires once, when the system colour panel closes
  // (React's onChange would fire on every `input` event while dragging). Attached through a
  // callback ref: the popover content mounts a render after `open` turns true.
  const onNativeChange = useCallback(
    (e: Event) => {
      latest.current.preview = (e.currentTarget as HTMLInputElement).value.toLowerCase();
      commitPreview();
    },
    [commitPreview],
  );
  const nativeEl = useRef<HTMLInputElement | null>(null);
  const nativeRef = useCallback(
    (el: HTMLInputElement | null) => {
      nativeEl.current?.removeEventListener('change', onNativeChange);
      nativeEl.current = el;
      el?.addEventListener('change', onNativeChange);
    },
    [onNativeChange],
  );

  const pick = (color: string | null) => {
    setPreview(null);
    onChange?.(color);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          const list = palette ?? readSwatchPalette();
          if (!palette) setColors(list);
          setPickerStart(resolveHexColor(value) ?? resolveHexColor(automaticColor) ?? list[0]);
        } else {
          // Closing while the system panel still shows a new colour keeps that colour.
          commitPreview();
        }
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={styles.well}
          aria-label={labelledBy ? undefined : `${ariaLabel}: ${value ? value.toUpperCase() : 'Automatic'}`}
          aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
          disabled={!onChange}
        >
          <span className={styles.swatch} style={{ background: shown }} />
          <span id={valueId} className={styles.wellText}>
            {preview ? preview.toUpperCase() : value ? value.toUpperCase() : 'Automatic'}
          </span>
          <ChevronDown className={styles.chevron} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent padding="sm" side="bottom" align="start" aria-label="Feature colours" className={styles.panel}>
        <div className={styles.grid} role="group" aria-label="Palette">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              className={cx(styles.chip, c === current && styles.selected)}
              style={{ background: c }}
              aria-label={c.toUpperCase()}
              aria-pressed={c === current}
              onClick={() => pick(c)}
            >
              {c === current ? <Check aria-hidden /> : null}
            </button>
          ))}
        </div>
        <div className={styles.footer}>
          <Button size="sm" variant="plain" onClick={() => pick(null)} aria-pressed={!value}>
            <span className={styles.auto}>
              <span className={styles.autoSwatch} style={{ background: automaticColor }} />
              Automatic
            </span>
          </Button>
          <label className={styles.custom} htmlFor={customId}>
            Other…
            {/* Uncontrolled: the system panel starts at the current colour and reports back
                through `input` (live preview) and `change` (commit) events. */}
            <input
              ref={nativeRef}
              key={pickerStart}
              id={customId}
              type="color"
              className={styles.native}
              defaultValue={pickerStart}
              onInput={(e) => {
                const next = e.currentTarget.value.toLowerCase();
                latest.current.preview = next;
                setPreview(next);
                onPreview?.(next);
              }}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
