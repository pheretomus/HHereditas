/**
 * Ruler ticks: "nice" steps (1, 2, 5 × 10^k bp) chosen so that tick labels never collide.
 * Tick values are 1-based base numbers (what users read); tick `n` is drawn at the centre of
 * base n, so at letter zoom the "100" tick sits under the 100th letter.
 */
import { formatInt } from '../common/format';
import type { LinearScale } from './viewport';

/** Smallest nice step (integer bp, 1/2/5 × 10^k) that is >= minStep. */
export function niceStep(minStep: number): number {
  if (!(minStep > 1)) return 1;
  const exp = Math.floor(Math.log10(minStep));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    const s = Math.round(m * base);
    if (s >= minStep - 1e-9) return s;
  }
  return Math.round(10 * base);
}

/** Tick label text. The unit follows the step so every label on a ruler uses the same unit. */
export function formatTick(n: number, step: number): string {
  if (step >= 500_000) return `${trimDecimals((n / 1_000_000).toFixed(step % 1_000_000 === 0 ? 0 : 1))} Mb`;
  if (step >= 1_000 && step % 1_000 === 0) return `${formatInt(n / 1_000)} kb`;
  return formatInt(n);
}

function trimDecimals(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export interface RulerTicks {
  /** Major step (bp) and the labelled tick values (1-based base numbers). */
  step: number;
  major: number[];
  /** Minor step (0 when there are no minor ticks) and the unlabelled tick values. */
  minorStep: number;
  minor: number[];
}

export interface RulerOptions {
  /** Visible x range (px); defaults to the plot area. */
  x0?: number;
  x1?: number;
  /** Width (px) of a tick label; used to space labels. */
  measure: (text: string) => number;
  /** Free space between neighbouring labels (px). */
  labelGap?: number;
  /** Minimum distance between minor ticks (px). */
  minMinorSpacing?: number;
}

/** Ticks for the visible part of a record of `seqLength` bases. */
export function rulerTicks(scale: LinearScale, seqLength: number, opts: RulerOptions): RulerTicks {
  const x0 = opts.x0 ?? scale.plotLeft;
  const x1 = opts.x1 ?? scale.plotLeft + scale.plotWidth;
  const gap = opts.labelGap ?? 28;
  const minMinor = opts.minMinorSpacing ?? 8;
  const k = scale.pxPerBp;
  if (seqLength <= 0 || !(k > 0)) return { step: 1, major: [], minor: [], minorStep: 0 };

  // Visible base numbers (1-based); tick n sits at the centre of base n.
  const first = Math.max(1, Math.ceil(scale.bp(x0) + 0.5));
  const last = Math.min(seqLength, Math.floor(scale.bp(x1) + 0.5));

  // Pick the step from the widest label it would produce; re-check because the unit (and so
  // the label width) can change with the step.
  let step = niceStep(56 / k);
  for (let i = 0; i < 4; i++) {
    const widest = Math.max(opts.measure(formatTick(Math.max(step, last - (last % step)), step)), 1);
    const needed = niceStep((widest + gap) / k);
    if (needed <= step) break;
    step = needed;
  }

  const major: number[] = [];
  if (last >= first) {
    for (let n = Math.ceil(first / step) * step; n <= last; n += step) major.push(n);
  }

  let minorStep = 0;
  for (const div of [5, 2]) {
    const s = step / div;
    if (Number.isInteger(s) && s >= 1 && s * k >= minMinor) {
      minorStep = s;
      break;
    }
  }
  const minor: number[] = [];
  if (minorStep > 0 && last >= first) {
    for (let n = Math.ceil(first / minorStep) * minorStep; n <= last; n += minorStep) {
      if (n % step !== 0) minor.push(n);
    }
  }
  return { step, major, minorStep, minor };
}
