/** Number formatting used across the visualizations (always en-US style: 2,686 bp). */

const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 2686 → "2,686". */
export function formatInt(n: number): string {
  return integerFormat.format(n);
}

/** 2686 → "2,686 bp". */
export function formatBp(n: number): string {
  return `${formatInt(n)} bp`;
}

/** Compact length for tick labels: 500 → "500", 2500 → "2.5 kb", 4641652 → "4.64 Mb". */
export function formatCompactBp(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${trimZeros((n / 1000).toFixed(n % 1000 === 0 ? 0 : n < 10_000 ? 2 : 1))} kb`;
  return `${trimZeros((n / 1_000_000).toFixed(2))} Mb`;
}

/** A 0-based base index shown to users as a 1-based position: 0 → "1". */
export function formatPosition(index: number): string {
  return formatInt(index + 1);
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
