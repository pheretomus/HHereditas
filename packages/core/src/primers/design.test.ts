import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Topology } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { sliceRange } from '../seq/range';
import { findBindingSites } from './binding';
import { DEFAULT_PRIMER_DESIGN, MAX_DESIGN_PRIMER_LENGTH, designPrimer, designPrimerPair, type DesignedPrimer } from './design';
import { tm } from './tm';

const PYTHON = fileURLToPath(new URL('../../../../tools/oracle/.venv/bin/python', import.meta.url));
const LIVE = fileURLToPath(new URL('../../../../tools/oracle/primers_live.py', import.meta.url));
const hasPython = existsSync(PYTHON);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDna(random: () => number, length: number, gc = 0.5): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += random() < gc ? (random() < 0.5 ? 'G' : 'C') : random() < 0.5 ? 'A' : 'T';
  }
  return s;
}

function genbankSequence(path: string): string {
  const text = readFileSync(path, 'utf8');
  const origin = text.indexOf('\nORIGIN');
  return text.slice(origin + 7, text.indexOf('\n//', origin)).replace(/[^A-Za-z]/g, '').toUpperCase();
}

/** The primer sequence read back from the template, per the documented direction convention. */
function readBack(template: string, p: DesignedPrimer): string {
  const top = sliceRange(template, p.range);
  return p.direction === 1 ? top : reverseComplement(top);
}

/** Independent re-implementation of the selection rule over all candidate lengths. */
function expectedChoice(template: string, topology: Topology, position: number, direction: 1 | -1, target: number) {
  const L = template.length;
  const out: { length: number; tm: number; clamp: boolean }[] = [];
  for (let length = 18; length <= 30; length++) {
    let top: string;
    if (topology === 'circular') {
      const start = direction === 1 ? position : position - length;
      top = sliceRange(template, { start: ((start % L) + L) % L, end: ((start % L) + L) % L + length });
    } else {
      if (direction === 1 ? position + length > L : position - length < 0) break;
      top = direction === 1 ? template.slice(position, position + length) : template.slice(position - length, position);
    }
    const seq = direction === 1 ? top : reverseComplement(top);
    out.push({ length, tm: tm(seq), clamp: /[GC]$/.test(seq) });
  }
  const d = (c: (typeof out)[number]) => Math.abs(c.tm - target);
  const closest = (list: typeof out) => list.reduce((b, c) => (d(c) < d(b) ? c : b));
  let chosen = closest(out);
  const clamped = out.filter((c) => c.clamp);
  if (!chosen.clamp && clamped.length) {
    const bc = closest(clamped);
    // a G/C clamp costing <= 1 °C wins, unless it leaves the ±2.5 °C window that the closest length is in
    if (d(bc) <= d(chosen) + 1 && (d(bc) <= 2.5 || d(chosen) > 2.5)) chosen = bc;
  }
  return { chosen, candidates: out };
}

describe('designPrimer', () => {
  const puc19 = genbankSequence(fileURLToPath(new URL('../../test/fixtures/genbank/pUC19_M77789.gb', import.meta.url)));

  it('designs a forward primer whose sequence is the top strand at the position', () => {
    const p = designPrimer(puc19, 'circular', { position: 400, direction: 1 });
    expect(p.direction).toBe(1);
    expect(p.range.start).toBe(400);
    expect(p.length).toBe(p.range.end - p.range.start);
    expect(p.sequence).toBe(puc19.slice(400, 400 + p.length));
    expect(p.length).toBeGreaterThanOrEqual(18);
    expect(p.length).toBeLessThanOrEqual(30);
    expect(Math.abs(p.tm - 60)).toBeLessThanOrEqual(2.5);
    expect(p.tm).toBeCloseTo(tm(p.sequence), 12);
    expect(p.gcClamp).toBe(/[GC]$/.test(p.sequence));
  });

  it('designs a reverse primer whose 5' + "' end sits at the position", () => {
    const p = designPrimer(puc19, 'circular', { position: 1200, direction: -1 });
    expect(p.range.end).toBe(1200);
    expect(p.sequence).toBe(reverseComplement(puc19.slice(1200 - p.length, 1200)));
    expect(Math.abs(p.tm - 60)).toBeLessThanOrEqual(2.5);
  });

  it('wraps through the origin of circular templates', () => {
    const L = puc19.length;
    const fwd = designPrimer(puc19, 'circular', { position: L - 7, direction: 1 });
    expect(fwd.range).toEqual({ start: L - 7, end: L - 7 + fwd.length });
    expect(fwd.sequence).toBe(puc19.slice(L - 7) + puc19.slice(0, fwd.length - 7));
    const rev = designPrimer(puc19, 'circular', { position: 5, direction: -1 });
    expect(rev.range).toEqual({ start: L + 5 - rev.length, end: L + 5 });
    expect(rev.sequence).toBe(reverseComplement(puc19.slice(L - (rev.length - 5)) + puc19.slice(0, 5)));
    // gap positions are taken modulo L on circular templates
    expect(designPrimer(puc19, 'circular', { position: -7, direction: 1 })).toEqual(fwd);
    expect(designPrimer(puc19, 'circular', { position: L + 5, direction: -1 })).toEqual(rev);
    // position L is the same gap as 0
    expect(designPrimer(puc19, 'circular', { position: L, direction: 1 })).toEqual(
      designPrimer(puc19, 'circular', { position: 0, direction: 1 }),
    );
    // on a linear template the same requests run out of sequence
    expect(() => designPrimer(puc19, 'linear', { position: L - 7, direction: 1 })).toThrow(RangeError);
    expect(() => designPrimer(puc19, 'linear', { position: 5, direction: -1 })).toThrow(/available/);
  });

  it('uses the bases available at the ends of linear templates', () => {
    const t = puc19.slice(0, 500);
    const p = designPrimer(t, 'linear', { position: 480, direction: 1 });
    expect(p.range.start).toBe(480);
    expect(p.range.end).toBeLessThanOrEqual(500); // only 18–20 nt are available
    expect(p.length).toBeGreaterThanOrEqual(18);
    const q = designPrimer(t, 'linear', { position: 18, direction: -1 });
    expect(q.range).toEqual({ start: 0, end: 18 }); // exactly minLength available
    expect(designPrimer(t, 'linear', { position: 0, direction: 1 }).range.start).toBe(0);
    expect(designPrimer(t, 'linear', { position: 500, direction: -1 }).range.end).toBe(500);
  });

  it('follows the selection rule: closest Tm, G/C clamp preferred within 1 °C unless it leaves the ±2.5 °C window', () => {
    const random = mulberry32(11);
    for (let trial = 0; trial < 120; trial++) {
      const topology: Topology = trial % 2 ? 'circular' : 'linear';
      const template = randomDna(random, 300, 0.3 + 0.4 * random());
      const direction = random() < 0.5 ? 1 : -1;
      const position = direction === 1 ? Math.floor(random() * 260) : 40 + Math.floor(random() * 260);
      const target = 52 + random() * 16;
      const p = designPrimer(template, topology, { position, direction, targetTm: target });
      const { chosen, candidates } = expectedChoice(template, topology, position, direction, target);
      expect(p.length).toBe(chosen.length);
      expect(readBack(template, p)).toBe(p.sequence);
      // whenever some length reaches the target within 2.5 °C, so does the design
      if (candidates.some((c) => Math.abs(c.tm - target) <= 2.5)) expect(Math.abs(p.tm - target)).toBeLessThanOrEqual(2.5);
      expect(p.warnings.length > 0).toBe(Math.abs(p.tm - target) > 2.5);
    }
  });

  it('warns when the target Tm is out of reach', () => {
    const atRich = 'ATTATAATTTAATATTATAAATTTATATAATTATTATAAAT'.repeat(3);
    const p = designPrimer(atRich, 'linear', { position: 0, direction: 1 });
    expect(p.length).toBe(30); // the longest primer gets closest
    expect(p.warnings.join(' ')).toMatch(/from the target/);
  });

  it('avoids ambiguous template bases when possible', () => {
    const t = puc19.slice(0, 40) + 'N' + puc19.slice(41, 300);
    const p = designPrimer(t, 'linear', { position: 20, direction: 1, minLength: 18, maxLength: 30 });
    expect(p.range.end).toBeLessThanOrEqual(40);
    expect(p.sequence).not.toContain('N');
    const forced = designPrimer(t, 'linear', { position: 35, direction: 1 });
    expect(forced.sequence).toContain('N');
    expect(forced.warnings.join(' ')).toMatch(/ambiguity/);
    expect(Number.isFinite(forced.tm)).toBe(true);
  });

  it('validates options', () => {
    expect(() => designPrimer(puc19, 'linear', { position: -1, direction: 1 })).toThrow(RangeError);
    expect(() => designPrimer(puc19, 'linear', { position: 1.5, direction: 1 })).toThrow(RangeError);
    expect(() => designPrimer(puc19, 'linear', { position: 10, direction: 1, minLength: 1 })).toThrow(RangeError);
    expect(() => designPrimer(puc19, 'linear', { position: 10, direction: 1, minLength: 25, maxLength: 20 })).toThrow(RangeError);
    expect(() => designPrimer(puc19, 'linear', { position: 10, direction: 0 as 1 })).toThrow(RangeError);
    expect(() => designPrimer('ACGT', 'circular', { position: 0, direction: 1 })).toThrow(RangeError);
    expect(() => designPrimer('', 'linear', { position: 0, direction: 1 })).toThrow(RangeError);
    expect(DEFAULT_PRIMER_DESIGN).toEqual({ targetTm: 60, minLength: 18, maxLength: 30 });
  });

  it('honours custom conditions', () => {
    const lowSalt = designPrimer(puc19, 'circular', { position: 400, direction: 1, conditions: { monovalentMilliMolar: 10, divalentMilliMolar: 0 } });
    expect(lowSalt.tm).toBeCloseTo(tm(lowSalt.sequence, { monovalentMilliMolar: 10, divalentMilliMolar: 0 }), 12);
    const normal = designPrimer(puc19, 'circular', { position: 400, direction: 1 });
    expect(lowSalt.length).toBeGreaterThanOrEqual(normal.length);
  });
});

describe('designPrimer review regressions', () => {
  const puc19 = genbankSequence(fileURLToPath(new URL('../../test/fixtures/genbank/pUC19_M77789.gb', import.meta.url)));
  const pbr322 = genbankSequence(fileURLToPath(new URL('../../test/fixtures/genbank/pBR322_J01749.gb', import.meta.url)));
  // RNA records keep U (types.ts convention 6 converts U to T for DNA records only).
  const GFP = 'GGCTAGCTTACGGATCCATGGCTAGCAAAGGAGAAGAACTTTTCACTGGAGTTGTCCCAATTCTTGTTGAATTAGATGGTGATGTTAATGGGCACAAATTTTCTG';
  // E. coli 16S rRNA, U00096.3 bases 224265..224364.
  const ECOLI_16S = 'AAGAAGCACCGGCTAACTCCGTGCCAGCAGCCGCGGTAATACGGAGGGTGCAAGCGTTAATCGGAATTACTGGGCGTAAAGCGCACGCAGGCGGTTTGTT';
  const rna = (dna: string) => dna.replace(/T/g, 'U');

  it('designs DNA primers (T, not U) on RNA templates, exactly as on their DNA form', () => {
    const p = designPrimer(rna(GFP), 'linear', { position: 20, direction: 1 });
    expect(p.sequence).not.toMatch(/U/);
    expect(p.warnings).toEqual([]);
    expect(p).toEqual(designPrimer(GFP, 'linear', { position: 20, direction: 1 }));
    expect(p).toMatchObject({ sequence: 'GCTAGCAAAGGAGAAGAACTTTTCAC', range: { start: 20, end: 46 } });
    expect(p.tm).toBeCloseTo(60.79, 2);
    expect(designPrimer(rna(GFP).toLowerCase(), 'linear', { position: 100, direction: -1 })).toEqual(
      designPrimer(GFP, 'linear', { position: 100, direction: -1 }),
    );
    expect(designPrimerPair(rna(GFP), 'linear', { start: 5, end: 100 })).toEqual(designPrimerPair(GFP, 'linear', { start: 5, end: 100 }));
  });

  it('a primer designed on an RNA record binds that record where it was designed (16S fragment)', () => {
    const p = designPrimer(rna(ECOLI_16S), 'linear', { position: 20, direction: 1 });
    expect(p.sequence).toBe('GTGCCAGCAGCCGCGGTAATAC');
    expect(p).toEqual(designPrimer(ECOLI_16S, 'linear', { position: 20, direction: 1 }));
    expect(p.warnings.join(' ')).not.toMatch(/ambiguity/);
    const sites = findBindingSites(rna(ECOLI_16S), 'linear', { id: 'd', name: 'd', sequence: p.sequence });
    expect(sites).toContainEqual(expect.objectContaining({ strand: 1, range: p.range, annealedLength: p.length }));
  });

  it('stays within ±2.5 °C of the target when some length allows it (pBR322 bases 51–83)', () => {
    const template = 'CACAGTTAAATTGCTAACGCAGTCAGGCACCGT';
    expect(pbr322.slice(50, 83)).toBe(template);
    const nineteen = reverseComplement(template.slice(14, 33)); // ACGGTGCCTGACTGCGTTA, 61.86 °C
    expect(Math.abs(tm(nineteen) - 60)).toBeLessThan(2.5);
    const p = designPrimer(template, 'linear', { position: 33, direction: -1 });
    expect(Math.abs(p.tm - 60)).toBeLessThanOrEqual(2.5);
    expect(p.warnings).toEqual([]);
    expect(Math.abs(designPrimer(pbr322, 'circular', { position: 83, direction: -1 }).tm - 60)).toBeLessThanOrEqual(2.5);
  });

  it('only leaves the ±2.5 °C window when no length is inside it (every gap of pBR322 and pUC19, both directions, 55/60/65 °C)', () => {
    let outside = 0;
    for (const template of [pbr322, puc19]) {
      for (let position = 0; position < template.length; position++) {
        for (const direction of [1, -1] as const) {
          for (const targetTm of [55, 60, 65]) {
            const p = designPrimer(template, 'circular', { position, direction, targetTm });
            const off = Math.abs(p.tm - targetTm) > 2.5;
            expect(p.warnings.length > 0).toBe(off);
            if (!off) continue;
            outside++;
            const { candidates } = expectedChoice(template, 'circular', position, direction, targetTm);
            const inside = candidates.filter((c) => Math.abs(c.tm - targetTm) <= 2.5);
            expect(inside, `${template.length} bp, position ${position}, direction ${direction}, target ${targetTm}`).toEqual([]);
          }
        }
      }
    }
    expect(outside).toBeGreaterThan(100); // the check is not vacuous
  });

  it('names the lengths actually considered when a template IUPAC code rules out longer primers', () => {
    const template = 'ATGAAATTTAAAGATTTCAA' + 'N' + 'GCGCGGCCGCATGCCGGCGCATCGATCGGCTAGC';
    const p = designPrimer(template, 'linear', { position: 0, direction: 1 });
    expect(p.length).toBe(20);
    const text = p.warnings.join(' ');
    expect(text).not.toMatch(/within 18–30 nt/);
    expect(text).toMatch(/18–20 nt/);
    expect(text).toMatch(/'N' at template index 20 \(base 21\)/);
    // a reverse primer reading the same bases from the reverse-complement template: the N is at index 34 there
    const rc = reverseComplement(template);
    expect(rc[34]).toBe('N');
    const rev = designPrimer(rc, 'linear', { position: rc.length, direction: -1 });
    expect(rev.sequence).toBe(p.sequence);
    expect(rev.warnings.join(' ')).toMatch(/18–20 nt/);
    expect(rev.warnings.join(' ')).toMatch(/'N' at template index 34 \(base 35\)/);
  });

  it('rejects an unbounded maxLength instead of doing quadratic work', () => {
    const random = mulberry32(1);
    const template = randomDna(random, 10_000);
    const t0 = performance.now();
    expect(() => designPrimer(template, 'circular', { position: 10, direction: 1, maxLength: Number.MAX_SAFE_INTEGER })).toThrow(RangeError);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(() =>
      designPrimerPair(template, 'circular', { start: 0, end: 5000 }, { maxLength: MAX_DESIGN_PRIMER_LENGTH + 1 }),
    ).toThrow(RangeError);
    // the largest accepted maxLength stays fast on a plasmid and on a 200 kb template
    const big = randomDna(random, 200_000);
    for (const t of [template, big]) {
      const t1 = performance.now();
      const long = designPrimer(t, 'circular', { position: 10, direction: 1, maxLength: MAX_DESIGN_PRIMER_LENGTH, targetTm: 85 });
      expect(performance.now() - t1).toBeLessThan(1000);
      expect(long.length).toBeGreaterThan(60);
    }
  });
});

describe('designPrimerPair', () => {
  const puc19 = genbankSequence(fileURLToPath(new URL('../../test/fixtures/genbank/pUC19_M77789.gb', import.meta.url)));

  it('amplifies exactly the target and the primers bind where designed', () => {
    const target = { start: 146, end: 469 }; // lacZα MCS region
    const pair = designPrimerPair(puc19, 'circular', target);
    expect(pair.productLength).toBe(323);
    expect(pair.forward.range.start).toBe(146);
    expect(pair.reverse.range.end).toBe(469);
    expect(pair.forward.direction).toBe(1);
    expect(pair.reverse.direction).toBe(-1);
    for (const p of [pair.forward, pair.reverse]) expect(Math.abs(p.tm - 60)).toBeLessThanOrEqual(2.5);
    // the binding-site finder sees the designed primers at their designed sites
    const fwdSites = findBindingSites(puc19, 'circular', { id: 'f', name: 'f', sequence: pair.forward.sequence });
    expect(fwdSites).toContainEqual(expect.objectContaining({ strand: 1, range: pair.forward.range }));
    const revSites = findBindingSites(puc19, 'circular', { id: 'r', name: 'r', sequence: pair.reverse.sequence });
    expect(revSites).toContainEqual(expect.objectContaining({ strand: -1, range: pair.reverse.range }));
  });

  it('handles targets across the origin and whole circles', () => {
    const L = puc19.length;
    const pair = designPrimerPair(puc19, 'circular', { start: L - 100, end: L + 150 });
    expect(pair.productLength).toBe(250);
    expect(pair.forward.range.start).toBe(L - 100);
    expect(pair.reverse.range.end % L).toBe(150);
    const whole = designPrimerPair(puc19, 'circular', { start: 1000, end: 1000 + L });
    expect(whole.productLength).toBe(L);
  });

  it('keeps primers inside short targets and rejects invalid ones', () => {
    const small = designPrimerPair(puc19, 'linear', { start: 600, end: 622 });
    expect(small.forward.range.end).toBeLessThanOrEqual(622);
    expect(small.reverse.range.start).toBeGreaterThanOrEqual(600);
    expect(() => designPrimerPair(puc19, 'linear', { start: 600, end: 610 })).toThrow(/at least 18/);
    expect(() => designPrimerPair(puc19, 'linear', { start: 100, end: 5000 })).toThrow(RangeError);
    expect(() => designPrimerPair(puc19, 'linear', { start: 300, end: 200 })).toThrow(RangeError);
  });
});

describe.skipIf(!hasPython)('designed primers vs primer3-py (live oracle)', () => {
  it('reports the same Tm as primer3 calc_tm for designed primers', () => {
    const random = mulberry32(2026);
    const designs: DesignedPrimer[] = [];
    for (let i = 0; i < 40; i++) {
      const template = randomDna(random, 400, 0.35 + 0.3 * random());
      designs.push(designPrimer(template, i % 2 ? 'circular' : 'linear', { position: 50 + i * 5, direction: i % 3 ? 1 : -1 }));
    }
    const request = { tm: designs.map((d) => [d.sequence, 50, 1.5, 0.6, 50, 'santalucia']) };
    const run = spawnSync(PYTHON, [LIVE], { input: JSON.stringify(request), encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const reply = JSON.parse(run.stdout) as { tm: number[] };
    designs.forEach((d, i) => expect(Math.abs(d.tm - reply.tm[i])).toBeLessThan(1e-9));
  });
});
