import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Primer, PrimerBindingSite, Topology } from '../types';
import { complementBase, iupacMatches, reverseComplement } from '../seq/alphabet';
import { mod, sliceRange } from '../seq/range';
import { DEFAULT_BINDING_OPTIONS, findAllBindingSites, findBindingSites, type BindingOptions } from './binding';
import { tm } from './tm';

interface OracleSite {
  strand: 1 | -1;
  start: number;
  end: number;
  annealedLength: number;
  mismatches: number;
  tailLength: number;
}
interface OracleCase {
  template: string;
  topology: Topology;
  primer: string;
  options: { minAnneal: number; anchor3: number; maxMismatches: number };
  sites: OracleSite[];
}
const oracle = JSON.parse(
  readFileSync(new URL('../../test/oracle/primers/binding.json', import.meta.url), 'utf8'),
) as { resumeMatches: number; cases: OracleCase[] };

const primer = (sequence: string, id = 'p1'): Primer => ({ id, name: id, sequence });

function strip(sites: PrimerBindingSite[]): OracleSite[] {
  return sites.map((s) => ({
    strand: s.strand,
    start: s.range.start,
    end: s.range.end,
    annealedLength: s.annealedLength,
    mismatches: s.mismatches,
    tailLength: s.tailLength,
  }));
}

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

function randomDna(random: () => number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += 'ACGT'[Math.floor(random() * 4)];
  return s;
}

/** Top-strand sequence of a GenBank file (minimal ORIGIN reader for tests). */
function genbankSequence(path: string): string {
  const text = readFileSync(path, 'utf8');
  const origin = text.indexOf('\nORIGIN');
  const end = text.indexOf('\n//', origin);
  return text.slice(origin + 7, end).replace(/[^A-Za-z]/g, '').toUpperCase();
}

describe('findBindingSites vs brute-force reference (oracle)', () => {
  it(`agrees on ${oracle.cases.length} random/planted/edge cases`, () => {
    expect(oracle.resumeMatches).toBe(2);
    let sites = 0;
    for (const c of oracle.cases) {
      const ours = findBindingSites(c.template, c.topology, primer(c.primer), { ...c.options, computeTm: false });
      expect(strip(ours), `${c.topology} ${c.template.length} bp, primer ${c.primer}, ${JSON.stringify(c.options)}`).toEqual(c.sites);
      sites += c.sites.length;
    }
    expect(sites).toBeGreaterThan(300);
  });

  it('covers both strands, origin-spanning sites, tails and mismatches', () => {
    const all = oracle.cases.flatMap((c) => c.sites.map((s) => ({ ...s, L: c.template.length })));
    expect(all.some((s) => s.strand === 1)).toBe(true);
    expect(all.some((s) => s.strand === -1)).toBe(true);
    expect(all.filter((s) => s.end > s.L).length).toBeGreaterThan(10);
    expect(all.filter((s) => s.mismatches > 0).length).toBeGreaterThan(10);
    expect(all.filter((s) => s.tailLength > 0).length).toBeGreaterThan(10);
    // templates as stored in RNA records (U) and in lower case, read as their DNA form
    const withSites = oracle.cases.filter((c) => c.sites.length > 0);
    expect(withSites.filter((c) => c.template.includes('U')).length).toBeGreaterThan(10);
    expect(withSites.filter((c) => /[a-z]/.test(c.template)).length).toBeGreaterThan(10);
  });
});

describe('findBindingSites semantics', () => {
  const anneal = 'ACGGATCCTTAGCAATGGCA'; // 20 nt
  const left = 'TTTTTTTTTT';
  const right = 'GGGGGGGGGG';

  it('finds a forward site (primer = top strand)', () => {
    const template = left + anneal + right;
    const sites = findBindingSites(template, 'linear', primer(anneal));
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      primerId: 'p1',
      strand: 1,
      range: { start: 10, end: 30 },
      annealedLength: 20,
      mismatches: 0,
      tailLength: 0,
    });
    expect(sites[0].tm).toBeCloseTo(tm(anneal), 12);
  });

  it('finds a reverse site (primer = reverse complement of the top strand)', () => {
    const template = left + reverseComplement(anneal) + right;
    const sites = findBindingSites(template, 'linear', primer(anneal));
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ strand: -1, range: { start: 10, end: 30 }, annealedLength: 20, tailLength: 0 });
  });

  it('reports the non-annealing 5' + "' tail", () => {
    const tail = 'GAATTCAAAAAAAAA'; // EcoRI site + spacer, does not match the template
    const template = 'C'.repeat(10) + anneal + right;
    const sites = findBindingSites(template, 'linear', primer(tail + anneal));
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ annealedLength: 20, tailLength: 15, range: { start: 10, end: 30 } });
    // the Tm is that of the annealed part only
    expect(sites[0].tm).toBeCloseTo(tm(anneal), 12);
  });

  it('extends the annealed region while bases keep matching (tail bases that happen to match anneal)', () => {
    const template = 'CCCCCCCCCA' + anneal + right; // the base before the site is A
    const sites = findBindingSites(template, 'linear', primer('GGA' + anneal));
    expect(sites[0]).toMatchObject({ annealedLength: 21, tailLength: 2, range: { start: 9, end: 30 } });
  });

  it('handles sites touching positions 0 and L of a linear template', () => {
    const atStart = findBindingSites(anneal + right, 'linear', primer(anneal));
    expect(atStart[0].range).toEqual({ start: 0, end: 20 });
    const atEnd = findBindingSites(left + anneal, 'linear', primer(anneal));
    expect(atEnd[0].range).toEqual({ start: 10, end: 30 });
    // a 5' tail hanging over the end of a linear template
    const overhang = findBindingSites(anneal + right, 'linear', primer('TTTTT' + anneal));
    expect(overhang[0]).toMatchObject({ range: { start: 0, end: 20 }, tailLength: 5 });
    const revAtEnd = findBindingSites(left + reverseComplement(anneal), 'linear', primer('GGGGG' + anneal));
    expect(revAtEnd[0]).toMatchObject({ strand: -1, range: { start: 10, end: 30 }, annealedLength: 20, tailLength: 5 });
  });

  it('finds origin-spanning sites on circular templates (both strands) but not on linear ones', () => {
    // anneal split across the origin: last 8 bases at the start, first 12 at the end
    const circ = anneal.slice(12) + 'T'.repeat(30) + anneal.slice(0, 12);
    const L = circ.length;
    const fwd = findBindingSites(circ, 'circular', primer(anneal));
    expect(fwd).toHaveLength(1);
    expect(fwd[0]).toMatchObject({ strand: 1, range: { start: L - 12, end: L + 8 }, annealedLength: 20 });
    expect(sliceRange(circ, fwd[0].range)).toBe(anneal);
    expect(findBindingSites(circ, 'linear', primer(anneal))).toEqual([]);

    const rc = reverseComplement(anneal);
    const circRev = rc.slice(5) + 'A'.repeat(30) + rc.slice(0, 5);
    const rev = findBindingSites(circRev, 'circular', primer(anneal));
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ strand: -1, range: { start: circRev.length - 5, end: circRev.length + 15 } });
    expect(reverseComplement(sliceRange(circRev, rev[0].range))).toBe(anneal);
  });

  it('a circular site ending exactly at the origin does not wrap', () => {
    const circ = 'T'.repeat(30) + anneal;
    expect(findBindingSites(circ, 'circular', primer(anneal))[0].range).toEqual({ start: 30, end: 50 });
  });

  it('accepts isolated mismatches only when matching resumes for two bases', () => {
    const t = 'CCCCCCCCCC' + anneal + 'CCCCCCCCCC';
    // mismatch 8 bases from the 3' end, followed (5'-wards) by matches
    const mm = anneal.slice(0, 11) + (anneal[11] === 'A' ? 'C' : 'A') + anneal.slice(12);
    expect(findBindingSites(t, 'linear', primer(mm))).toEqual([]); // maxMismatches 0, only 8 3' bases match
    const one = findBindingSites(t, 'linear', primer(mm), { maxMismatches: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ annealedLength: 20, mismatches: 1, tailLength: 0 });
    // a mismatch followed by a single match is a tail, not an annealed mismatch
    const t2 = 'CCCCCCCCCCC' + anneal.slice(2) + 'CCCCCCCCCC'; // template: ...C C | anneal[2..]
    const p2 = 'AG' + anneal.slice(2); // 5'-A G-...: G mismatches C, A mismatches C
    const s2 = findBindingSites(t2, 'linear', primer(p2), { maxMismatches: 2 });
    expect(s2[0]).toMatchObject({ annealedLength: 18, mismatches: 0, tailLength: 2 });
    // adjacent mismatches stop the walk
    const p3 = 'TT' + anneal.slice(0, 2) + 'GG' + anneal.slice(4);
    const t3 = 'TTCCTT' + anneal.slice(0, 2) + 'CC' + anneal.slice(4) + 'CCCC';
    const s3 = findBindingSites(t3, 'linear', primer(p3), { maxMismatches: 3, minAnneal: 10 });
    expect(s3[0]).toMatchObject({ annealedLength: 16, mismatches: 0 });
  });

  it('respects the mismatch budget and the 3' + "' anchor", () => {
    const t = 'CCCCCCCCCC' + anneal + 'CCCCCCCCCC';
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'C' : 'A') + s.slice(i + 1);
    const twoMm = flip(flip(anneal, 4), 10); // mismatches 15 and 9 bases from the 3' end
    // budget 1: the walk accepts the first mismatch and stops at the second (15 bases annealed)
    expect(findBindingSites(t, 'linear', primer(twoMm), { maxMismatches: 1, minAnneal: 15 })[0]).toMatchObject({
      annealedLength: 15,
      mismatches: 1,
      tailLength: 5,
    });
    expect(findBindingSites(t, 'linear', primer(twoMm), { maxMismatches: 1, minAnneal: 16 })).toEqual([]);
    expect(findBindingSites(t, 'linear', primer(twoMm), { maxMismatches: 0, minAnneal: 9 })[0]).toMatchObject({
      annealedLength: 9,
      mismatches: 0,
    });
    expect(findBindingSites(t, 'linear', primer(twoMm), { maxMismatches: 2 })[0]).toMatchObject({
      annealedLength: 20,
      mismatches: 2,
    });
    // mismatch inside the 3' anchor
    const nearEnd = flip(anneal, 17); // 3rd base from the 3' end
    expect(findBindingSites(t, 'linear', primer(nearEnd), { maxMismatches: 2 })).toEqual([]);
    expect(findBindingSites(t, 'linear', primer(nearEnd), { maxMismatches: 2, anchor3: 2 })[0]).toMatchObject({
      annealedLength: 20,
      mismatches: 1,
    });
  });

  it('matches degenerate primers with IUPAC rules and resolves them for the Tm', () => {
    const template = 'CCCCCCCCCC' + anneal + 'CCCCCCCCCC';
    const degenerate = 'ACRGATCCTTNGCAATGGCA'; // R accepts G, N accepts A
    const sites = findBindingSites(template, 'linear', primer(degenerate));
    expect(sites).toHaveLength(1);
    expect(sites[0].tm).toBeCloseTo(tm(anneal), 12); // R/N resolved to the template's G and A
    expect(iupacMatches('R', 'G')).toBe(true);
    // a template N only matches a primer N
    const withN = 'CCCCCCCCCC' + anneal.slice(0, 10) + 'N' + anneal.slice(11) + 'CCCCCCCCCC';
    expect(findBindingSites(withN, 'linear', primer(anneal))).toEqual([]);
    expect(findBindingSites(withN, 'linear', primer(anneal.slice(0, 10) + 'N' + anneal.slice(11)))).toHaveLength(1);
  });

  it('handles empty input and primers longer than the template', () => {
    expect(findBindingSites('ACGT', 'linear', primer(''))).toEqual([]);
    expect(findBindingSites('', 'circular', primer(anneal))).toEqual([]);
    const long = 'GGGGGGGGGGGGGGG' + anneal;
    const linear = findBindingSites(anneal, 'linear', primer(long));
    expect(linear).toEqual([
      expect.objectContaining({ strand: 1, range: { start: 0, end: 20 }, annealedLength: 20, tailLength: 15 }),
    ]);
    // circular: the annealed region is capped at one full turn
    const circular = findBindingSites(anneal, 'circular', primer(anneal.slice(10) + anneal));
    expect(circular).toEqual([
      expect.objectContaining({ strand: 1, range: { start: 0, end: 20 }, annealedLength: 20, tailLength: 10 }),
    ]);
    // primer shorter than minAnneal cannot anneal 15 bases
    expect(findBindingSites(anneal, 'linear', primer(anneal.slice(8)))).toEqual([]);
    expect(findBindingSites(anneal, 'linear', primer(anneal.slice(8)), { minAnneal: 12 })).toHaveLength(1);
  });

  it('binds an all-N primer everywhere and enforces maxSites', () => {
    const template = 'ACGTACGGATCCTTAGCAATGGCA'; // 24 bp
    const n18 = primer('N'.repeat(18));
    const linear = findBindingSites(template, 'linear', n18);
    // every 3' position with >= 15 template bases available (5' overhang at the ends is tail)
    expect(linear).toHaveLength(2 * (24 - 15 + 1));
    expect(linear.filter((s) => s.annealedLength === 18)).toHaveLength(2 * (24 - 18 + 1));
    expect(linear.every((s) => s.mismatches === 0 && s.annealedLength + s.tailLength === 18)).toBe(true);
    expect(findBindingSites(template, 'circular', n18)).toHaveLength(48);
    expect(() => findBindingSites(template, 'circular', n18, { maxSites: 47 })).toThrow(RangeError);
    // the template's own N never matches a concrete primer base, but N matches N
    expect(findBindingSites('NNNNNNNNNNNNNNNNNN', 'linear', primer('A'.repeat(18)))).toEqual([]);
    expect(findBindingSites('NNNNNNNNNNNNNNNNNN', 'linear', n18, { minAnneal: 18 })).toHaveLength(2);
  });

  it('omits the Tm when asked or when fewer than 2 bases anneal', () => {
    const template = 'CCCCCCCCCC' + anneal;
    expect(findBindingSites(template, 'linear', primer(anneal), { computeTm: false })[0].tm).toBeUndefined();
    const single = findBindingSites('ACGT', 'linear', primer('T'), { minAnneal: 1, anchor3: 1 });
    expect(single.length).toBeGreaterThan(0);
    expect(single.every((s) => s.tm === undefined)).toBe(true);
    // conditions are passed through
    const highSalt = findBindingSites(template, 'linear', primer(anneal), { conditions: { monovalentMilliMolar: 200 } });
    expect(highSalt[0].tm).toBeCloseTo(tm(anneal, { monovalentMilliMolar: 200 }), 12);
  });

  it('validates options and primer characters', () => {
    expect(() => findBindingSites('ACGT', 'linear', primer('ACGT'), { minAnneal: -1 })).toThrow(RangeError);
    expect(() => findBindingSites('ACGT', 'linear', primer('ACGT'), { maxMismatches: 1.5 })).toThrow(RangeError);
    expect(() => findBindingSites('ACGT', 'linear', primer('AC GT'))).toThrow(/non-IUPAC/);
    expect(findBindingSites('CCCC' + anneal, 'linear', primer(anneal.toLowerCase()))).toHaveLength(1);
    expect(DEFAULT_BINDING_OPTIONS).toMatchObject({ minAnneal: 15, anchor3: 5, maxMismatches: 0, computeTm: true });
  });

  it('does not mutate its inputs', () => {
    const p = primer(anneal);
    const opts: BindingOptions = { maxMismatches: 1, conditions: { monovalentMilliMolar: 100 } };
    const snapshot = JSON.stringify([p, opts]);
    findBindingSites('CCCC' + anneal, 'linear', p, opts);
    expect(JSON.stringify([p, opts])).toBe(snapshot);
  });
});

describe('templates as stored in RNA records (U) and other character forms (review regressions)', () => {
  // types.ts convention 6 only converts U to T for DNA records: RNA records keep U (parseFasta reads
  // "U without T" as RNA; the GenBank reader keeps U for RNA/rRNA/tRNA). A DNA primer must still bind them.
  const GFP = 'GGCTAGCTTACGGATCCATGGCTAGCAAAGGAGAAGAACTTTTCACTGGAGTTGTCCCAATTCTTGTTGAATTAGATGGTGATGTTAATGGGCACAAATTTTCTG';
  // E. coli 16S rRNA, U00096.3 bases 224265..224364 (contains the 515F site).
  const ECOLI_16S = 'AAGAAGCACCGGCTAACTCCGTGCCAGCAGCCGCGGTAATACGGAGGGTGCAAGCGTTAATCGGAATTACTGGGCGTAAAGCGCACGCAGGCGGTTTGTT';
  const rna = (dna: string) => dna.replace(/T/g, 'U');

  it('finds the same sites on the RNA form of a template as on its DNA form (RT and forward primers)', () => {
    const rt = primer('CAGAAAATTTGTGCCCATTAACATC', 'rt'); // reverse-transcription primer
    const fwd = primer('ATGGCTAGCAAAGGAGAAGAACT', 'fwd');
    expect(findBindingSites(GFP, 'linear', rt)).toEqual([
      expect.objectContaining({ strand: -1, range: { start: 80, end: 105 }, annealedLength: 25, mismatches: 0, tailLength: 0 }),
    ]);
    expect(findBindingSites(GFP, 'linear', fwd)).toEqual([expect.objectContaining({ strand: 1, range: { start: 17, end: 40 } })]);
    for (const p of [rt, fwd]) expect(findBindingSites(rna(GFP), 'linear', p)).toEqual(findBindingSites(GFP, 'linear', p));
  });

  it('finds the degenerate 16S primer 515F on an RNA 16S fragment, with the same Tm', () => {
    const p515F = primer('GTGYCAGCMGCCGCGGTAA', '515F');
    const onDna = findBindingSites(ECOLI_16S, 'linear', p515F);
    expect(onDna).toEqual([
      expect.objectContaining({ strand: 1, range: { start: 20, end: 39 }, annealedLength: 19, mismatches: 0, tailLength: 0 }),
    ]);
    expect(onDna[0].tm).toBeCloseTo(tm('GTGCCAGCAGCCGCGGTAA'), 12); // Y and M resolved to the template's C and A
    expect(findBindingSites(rna(ECOLI_16S), 'linear', p515F)).toEqual(onDna);
  });

  it('reads U as T and lower case as upper case anywhere in the template (circular, both strands, mismatches)', () => {
    const random = mulberry32(515);
    for (let trial = 0; trial < 40; trial++) {
      const L = 60 + Math.floor(random() * 300);
      const template = randomDna(random, L);
      const s = Math.floor(random() * L);
      let p = sliceRange(template, { start: s, end: s + 22 });
      if (random() < 0.5) p = reverseComplement(p);
      const options: BindingOptions = { maxMismatches: 1, minAnneal: 12 };
      const expected = findBindingSites(template, 'circular', primer(p), options);
      expect(expected.length).toBeGreaterThan(0);
      const mixed = rna(template)
        .split('')
        .map((ch) => (random() < 0.3 ? ch.toLowerCase() : ch))
        .join('');
      expect(findBindingSites(mixed, 'circular', primer(p), options)).toEqual(expected);
      expect(findAllBindingSites(mixed, 'circular', [primer(p)], options)).toEqual(expected);
    }
  });

  it('rejects primer characters that only become IUPAC letters when upper-cased (ß → SS, ſ → S, ﬆ → ST)', () => {
    const template = 'CCCCCCCCCCACGGATCCTTAGCAATGGCA';
    for (const bad of ['ßACGGATCCTTAGCAATGGCA', 'ACGGATCCTTAGCAATGGCAſ', 'ﬆACGGATCCTTAGCAATGGCA', 'ACGGATCCTTAGCAATGGCAﬅ']) {
      expect(() => findBindingSites(template, 'linear', primer(bad))).toThrow(RangeError);
    }
    // accepted case and U forms never change the length: annealedLength + tailLength = primer length
    const p = primer('gaattcACGGAUCCUUAGCAAUGGCA'); // the tail's 3' c faces an A: 20 bases anneal
    const [site] = findBindingSites('AAAAAAAAAAACGGATCCTTAGCAATGGCA', 'linear', p);
    expect(site).toMatchObject({ annealedLength: 20, tailLength: 6 });
    expect(site.annealedLength + site.tailLength).toBe(p.sequence.length);
  });
});

describe('findAllBindingSites', () => {
  it('merges primers, sorts by start and removes duplicate entries', () => {
    const a = 'ACGGATCCTTAGCAATGGCA';
    const b = 'TTGACAGCTAGCTCAGTCCT';
    const template = 'C'.repeat(40) + a + 'C'.repeat(10) + reverseComplement(b) + 'C'.repeat(10) + b;
    const pa = primer(a, 'a');
    const pb = primer(b, 'b');
    const sites = findAllBindingSites(template, 'linear', [pb, pa, pa]);
    expect(sites.map((s) => [s.primerId, s.strand, s.range.start])).toEqual([
      ['a', 1, 40],
      ['b', -1, 70],
      ['b', 1, 100],
    ]);
    expect(findAllBindingSites(template, 'linear', [])).toEqual([]);
  });
});

describe('findBindingSites properties (seeded random)', () => {
  const random = mulberry32(42);

  it('every reported site satisfies the matching rules', () => {
    for (let trial = 0; trial < 150; trial++) {
      const L = 50 + Math.floor(random() * 400);
      const template = randomDna(random, L);
      const topology: Topology = random() < 0.5 ? 'circular' : 'linear';
      // a primer taken from the template (possibly across the origin) with random mutations
      const start = Math.floor(random() * L);
      const len = 15 + Math.floor(random() * 15);
      let p = topology === 'circular' ? sliceRange(template, { start, end: start + len }) : template.slice(start, start + len);
      if (p.length < 10) continue;
      if (random() < 0.5) p = reverseComplement(p);
      p = p.split('').map((ch, i) => (i < p.length - 6 && random() < 0.08 ? complementBase(ch) : ch)).join('');
      const options = { maxMismatches: Math.floor(random() * 3), minAnneal: 10, anchor3: 4 };
      for (const site of findBindingSites(template, topology, primer(p), options)) {
        const top = sliceRange(template, site.range);
        const annealedPrimerPart = p.slice(p.length - site.annealedLength);
        const asTop = site.strand === 1 ? annealedPrimerPart : reverseComplement(annealedPrimerPart);
        let mismatches = 0;
        for (let i = 0; i < top.length; i++) if (!iupacMatches(asTop[i], top[i])) mismatches++;
        expect(mismatches).toBe(site.mismatches);
        expect(site.mismatches).toBeLessThanOrEqual(options.maxMismatches);
        expect(site.annealedLength + site.tailLength).toBe(p.length);
        expect(site.range.start).toBeGreaterThanOrEqual(0);
        expect(site.range.start).toBeLessThan(L);
        if (topology === 'linear') expect(site.range.end).toBeLessThanOrEqual(L);
      }
    }
  });

  it('is symmetric under reverse-complementing the template', () => {
    for (let trial = 0; trial < 60; trial++) {
      const L = 60 + Math.floor(random() * 200);
      const template = randomDna(random, L);
      const topology: Topology = random() < 0.5 ? 'circular' : 'linear';
      const s = Math.floor(random() * (L - 20));
      const p = primer(template.slice(s, s + 20));
      const sites = findBindingSites(template, topology, p, { maxMismatches: 1, minAnneal: 12 });
      const mirrored = findBindingSites(reverseComplement(template), topology, p, { maxMismatches: 1, minAnneal: 12 });
      const mapped = mirrored
        .map((site) => {
          const len = site.range.end - site.range.start;
          const start = mod(L - site.range.end, L);
          return { ...site, strand: -site.strand as 1 | -1, range: { start, end: start + len } };
        })
        .sort((a, b) => a.range.start - b.range.start || b.strand - a.strand || a.range.end - b.range.end);
      expect(strip(mapped)).toEqual(strip(sites));
    }
  });

  it('is invariant under rotation of a circular template', () => {
    for (let trial = 0; trial < 60; trial++) {
      const L = 40 + Math.floor(random() * 200);
      const template = randomDna(random, L);
      const s = Math.floor(random() * L);
      const p = primer(sliceRange(template, { start: s, end: s + 18 }));
      const shift = Math.floor(random() * L);
      const rotated = template.slice(shift) + template.slice(0, shift);
      const original = strip(findBindingSites(template, 'circular', p));
      const moved = strip(findBindingSites(rotated, 'circular', p))
        .map((site) => {
          const start = mod(site.start + shift, L);
          return { ...site, start, end: start + site.annealedLength };
        })
        .sort((a, b) => a.start - b.start || b.strand - a.strand || a.end - b.end);
      expect(moved).toEqual(original);
    }
  });
});

describe('findBindingSites on real sequences and performance', () => {
  const puc19 = genbankSequence(new URL('../../test/fixtures/genbank/pUC19_M77789.gb', import.meta.url).pathname);

  it('places the M13 primers on pUC19 (M77789)', () => {
    expect(puc19).toHaveLength(2686);
    const m13fwd = findBindingSites(puc19, 'circular', primer('GTAAAACGACGGCCAGT', 'M13fwd'), { minAnneal: 15 });
    expect(m13fwd).toEqual([expect.objectContaining({ strand: -1, range: { start: 289, end: 306 }, annealedLength: 17 })]);
    const m13rev = findBindingSites(puc19, 'circular', primer('CAGGAAACAGCTATGAC', 'M13rev'));
    expect(m13rev).toEqual([expect.objectContaining({ strand: 1, range: { start: 203, end: 220 } })]);
  });

  it('50 primers × 10 kb plasmid in < 50 ms', () => {
    const random = mulberry32(5);
    const template = puc19 + randomDna(random, 10000 - puc19.length);
    const primers = Array.from({ length: 50 }, (_, i) => {
      const s = Math.floor(random() * (template.length - 25));
      const p = template.slice(s, s + 20 + (i % 6));
      return primer(i % 2 ? reverseComplement(p) : 'GCGC' + p, `p${i}`);
    });
    findAllBindingSites(template, 'circular', primers); // warm-up (JIT)
    const t0 = performance.now();
    const sites = findAllBindingSites(template, 'circular', primers);
    const elapsed = performance.now() - t0;
    expect(sites.length).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(50);
  });

  const ecoliPath = new URL('../../test/fixtures/large/ecoli_U00096.3.gb', import.meta.url).pathname;
  it.skipIf(!existsSync(ecoliPath))('1 primer on the 4.6 Mb E. coli genome in < 1 s', () => {
    const genome = genbankSequence(ecoliPath);
    expect(genome.length).toBeGreaterThan(4_600_000);
    const p = primer(genome.slice(1_000_000, 1_000_022), 'ecoli');
    findBindingSites(genome, 'circular', primer('ACGTGGCATTGCAAGGCTAA', 'warm'));
    for (const options of [{}, { maxMismatches: 2 }] as BindingOptions[]) {
      const t0 = performance.now();
      const sites = findBindingSites(genome, 'circular', p, options);
      const elapsed = performance.now() - t0;
      expect(sites.some((s) => s.strand === 1 && s.range.start === 1_000_000)).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    }
  });
});
