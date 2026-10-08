/** Parsing, formatting and stepping rules for NumberField (pure, unit-tested). */

const grouping = new Map<number, Intl.NumberFormat>();

function formatter(precision: number): Intl.NumberFormat {
  let f = grouping.get(precision);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: precision });
    grouping.set(precision, f);
  }
  return f;
}

/** Number of decimals implied by a step: 1 → 0, 0.5 → 1, 0.01 → 2. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || Number.isInteger(step)) return 0;
  const s = String(step);
  const e = s.indexOf('e-');
  if (e >= 0) return Number(s.slice(e + 2));
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** 1256 → "1,256"; 52.25 with precision 1 → "52.3". */
export function formatNumberValue(value: number, precision: number): string {
  return formatter(precision).format(value);
}

/**
 * Lenient parse of user input: accepts thousands separators, spaces, a Unicode minus,
 * a leading "+", and ignores a trailing unit ("12 bp"). Returns null for anything else.
 */
export function parseNumberInput(text: string): number | null {
  const cleaned = text
    .trim()
    .replace(/[−‒–]/g, '-')
    .replace(/[,\s_]/g, '')
    .replace(/[a-zA-Z%°µ]+$/u, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Clamp to [min, max] and round to `precision` decimals. */
export function normalizeNumber(value: number, min: number, max: number, precision: number): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Math.min(max, Math.max(min, rounded));
}

/** One step up (+1) or down (-1) from `value`, snapping to the step grid like NSStepper. */
export function stepNumber(
  value: number | null,
  direction: 1 | -1,
  step: number,
  min: number,
  max: number,
  precision: number,
): number {
  const base = value ?? (direction > 0 ? Math.max(min, 0) - step : Math.min(max, 0) + step);
  const origin = Number.isFinite(min) ? min : 0;
  const offset = (base - origin) / step;
  const snapped = direction > 0 ? Math.floor(offset + 1e-9) + 1 : Math.ceil(offset - 1e-9) - 1;
  return normalizeNumber(origin + snapped * step, min, max, precision);
}
