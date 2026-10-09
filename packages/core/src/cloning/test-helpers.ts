/**
 * Helpers shared by the cloning tests (pure; not exported from the module index).
 */
import { reverseComplement } from '../seq/alphabet';

/** Lexicographically smallest rotation (Booth's algorithm). */
export function minRotation(s: string): string {
  const n = s.length;
  if (n === 0) return s;
  const d = s + s;
  const f = new Int32Array(2 * n).fill(-1);
  let k = 0;
  for (let j = 1; j < 2 * n; j++) {
    let i = f[j - k - 1];
    while (i !== -1 && d[j] !== d[k + i + 1]) {
      if (d[j] < d[k + i + 1]) k = j - i - 1;
      i = f[i];
    }
    if (i === -1 && d[j] !== d[k + i + 1]) {
      if (d[j] < d[k + i + 1]) k = j;
      f[j - k] = -1;
    } else {
      f[j - k] = i + 1;
    }
  }
  return d.slice(k, k + n);
}

/** Canonical form of a circular sequence: smallest rotation of either strand. */
export function canonicalCircular(s: string): string {
  const a = minRotation(s.toUpperCase());
  const b = minRotation(reverseComplement(s.toUpperCase()));
  return a < b ? a : b;
}

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random DNA of length n avoiding the given sites on both strands. */
export function randomDna(rand: () => number, n: number, avoid: readonly string[] = []): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < n; i++) s += 'ACGT'[Math.floor(rand() * 4)];
    if (!avoid.some((a) => s.includes(a) || s.includes(reverseComplement(a)))) return s;
  }
}
