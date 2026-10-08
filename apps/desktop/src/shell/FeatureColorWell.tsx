import { useId, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger, cx } from '@hhereditas/ui';
import styles from './FeatureColorWell.module.css';

const SWATCH_COUNT = 16;

/**
 * The feature colour palette, read from the --hh-swatch-* design tokens (hex values that
 * are written into documents). Missing tokens are skipped.
 */
export function readSwatchPalette(root: Element = document.documentElement): string[] {
  const style = getComputedStyle(root);
  const out: string[] = [];
  for (let i = 1; i <= SWATCH_COUNT; i++) {
    const value = style.getPropertyValue(`--hh-swatch-${i}`).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(value)) out.push(value);
  }
  return out;
}

export interface FeatureColorWellProps {
  /** The feature's own colour ('#rrggbb'); undefined when it uses its type's colour. */
  value?: string;
  /** CSS colour shown for the automatic (type) colour. */
  automaticColor: string;
  /** New colour, or null for "back to the type colour". Omit for a read-only well. */
  onChange?: (color: string | null) => void;
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
  palette,
  'aria-label': ariaLabel = 'Colour',
  'aria-labelledby': labelledBy,
}: FeatureColorWellProps) {
  const [open, setOpen] = useState(false);
  const [colors, setColors] = useState<readonly string[]>(() => palette ?? []);
  const customId = useId();
  const valueId = useId();
  const shown = value ?? automaticColor;
  const current = value?.toLowerCase();

  const pick = (color: string | null) => {
    onChange?.(color);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o && !palette) setColors(readSwatchPalette());
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
            {value ? value.toUpperCase() : 'Automatic'}
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
            <input
              id={customId}
              type="color"
              className={styles.native}
              value={/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#808080'}
              onChange={(e) => onChange?.(e.target.value.toLowerCase())}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}
