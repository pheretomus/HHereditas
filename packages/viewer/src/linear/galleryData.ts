/**
 * Demo data for the linear-map gallery and performance checks: a synthetic bacterial genome,
 * primers and ORFs. Development only (not exported from the package).
 */
import type { EnzymeSite, Feature, Orf, Primer, PrimerBindingSite, SeqRecord } from '@hhereditas/core';
import { reverseComplement } from '@hhereditas/core';

/** Small, fast, seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASES = 'ACGT';

function randomSequence(length: number, random: () => number): string {
  const chunk = 1 << 16;
  const parts: string[] = [];
  for (let done = 0; done < length; done += chunk) {
    const n = Math.min(chunk, length - done);
    const codes = new Uint8Array(n);
    for (let i = 0; i < n; i++) codes[i] = BASES.charCodeAt((random() * 4) | 0);
    parts.push(new TextDecoder().decode(codes));
  }
  return parts.join('');
}

let genomeCache: { record: SeqRecord; enzymeSites: EnzymeSite[] } | null = null;

/**
 * A 4.64 Mb circular "genome" with ~4,500 features (CDS, tRNA, rRNA, repeats, mobile
 * elements, a few multi-segment features) and ~150 rare-cutter sites. Built once, lazily.
 */
export function syntheticGenome(): { record: SeqRecord; enzymeSites: EnzymeSite[] } {
  if (genomeCache) return genomeCache;
  const random = rng(4_641_652);
  const L = 4_641_652;
  const seq = randomSequence(L, random);
  const features: Feature[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const geneName = () =>
    `${letters[(random() * 26) | 0]}${letters[(random() * 26) | 0]}${letters[(random() * 26) | 0]}${letters[(random() * 26) | 0].toUpperCase()}`;
  let p = 190;
  let n = 0;
  while (p < L - 4000) {
    const r = random();
    let type = 'CDS';
    let len = 300 + Math.floor(random() * random() * 2700);
    if (r < 0.02) {
      type = 'tRNA';
      len = 72 + Math.floor(random() * 20);
    } else if (r < 0.025) {
      type = 'rRNA';
      len = 1500 + Math.floor(random() * 1400);
    } else if (r < 0.04) {
      type = 'repeat_region';
      len = 30 + Math.floor(random() * 200);
    } else if (r < 0.043) {
      type = 'mobile_element';
      len = 1200 + Math.floor(random() * 1500);
    }
    const strand: 1 | -1 = random() < 0.5 ? 1 : -1;
    n++;
    const name = type === 'CDS' ? geneName() : type === 'tRNA' ? `tRNA-${'ACDEFGHIKLMNPQRSTVWY'[(random() * 20) | 0]}` : type === 'rRNA' ? `${['16S', '23S', '5S'][(random() * 3) | 0]} rRNA` : type === 'repeat_region' ? 'REP' : `IS${1 + ((random() * 30) | 0)}`;
    const id = `g${n}`;
    // ~1 % of CDS are split in two (e.g. programmed frameshift / intein), drawn as joins
    const segments =
      type === 'CDS' && random() < 0.01 && len > 900
        ? [
            { start: p, end: p + Math.floor(len * 0.45) },
            { start: p + Math.floor(len * 0.55), end: p + len },
          ]
        : [{ start: p, end: p + len }];
    features.push({ id, type, name, strand, segments, qualifiers: [{ key: 'label', value: name }] });
    // genes are dense (~88 % coding); some overlap their neighbour by a few bp
    p += len + (random() < 0.15 ? -Math.floor(random() * 30) : 20 + Math.floor(random() * random() * 600));
  }
  // one feature wrapping the origin
  features.push({
    id: 'g-ori',
    type: 'rep_origin',
    name: 'oriC',
    strand: 0,
    segments: [{ start: L - 120, end: L + 112 }],
    qualifiers: [{ key: 'label', value: 'oriC' }],
  });

  const enzymes: Array<{ name: string; count: number; site: number; cut: number; cutBottom: number }> = [
    { name: 'NotI', count: 14, site: 8, cut: 2, cutBottom: 6 },
    { name: 'AscI', count: 9, site: 8, cut: 2, cutBottom: 6 },
    { name: 'PacI', count: 46, site: 8, cut: 5, cutBottom: 3 },
    { name: 'SwaI', count: 38, site: 8, cut: 4, cutBottom: 4 },
    { name: 'SfiI', count: 24, site: 13, cut: 8, cutBottom: 5 },
    { name: 'PmeI', count: 17, site: 8, cut: 4, cutBottom: 4 },
    { name: 'I-SceI', count: 1, site: 18, cut: 9, cutBottom: 5 },
    { name: 'AsiSI', count: 1, site: 8, cut: 5, cutBottom: 3 },
  ];
  const enzymeSites: EnzymeSite[] = [];
  for (const e of enzymes) {
    for (let k = 0; k < e.count; k++) {
      const start = Math.floor(random() * (L - 40));
      enzymeSites.push({
        enzyme: e.name,
        range: { start, end: start + e.site },
        strand: 1,
        cuts: [{ top: start + e.cut, bottom: start + e.cutBottom }],
      });
    }
  }
  enzymeSites.sort((a, b) => a.range.start - b.range.start);

  const record: SeqRecord = {
    id: 'synthetic-genome',
    name: 'Synthetic genome',
    description: 'Synthetic 4.64 Mb circular chromosome for performance checks',
    seq,
    topology: 'circular',
    molecule: 'DNA',
    features,
    primers: [],
    meta: {},
  };
  genomeCache = { record, enzymeSites };
  return genomeCache;
}

/**
 * A 12 kb linear genomic locus with spliced genes on both strands (mRNA / CDS joins), a
 * promoter, a polyA signal and a repeat: exercises multi-segment features (exons joined by
 * intron lines), the arrow head on the 3' exon and dark custom colours (light label text).
 */
export function demoGeneLocus(): SeqRecord {
  const random = rng(12_000);
  const seq = randomSequence(12_000, random);
  const f = (
    id: string,
    type: string,
    name: string,
    strand: 1 | -1 | 0,
    segments: Array<[number, number]>,
  ): Feature => ({
    id,
    type,
    name,
    strand,
    segments: segments.map(([start, end]) => ({ start, end })),
    qualifiers: [{ key: 'label', value: name }],
  });
  const exonsA: Array<[number, number]> = [
    [900, 1240],
    [2010, 2290],
    [3400, 3910],
    [5020, 5330],
    [6150, 6900],
  ];
  const exonsB: Array<[number, number]> = [
    [8100, 8600],
    [9250, 9500],
    [10400, 11300],
  ];
  return {
    id: 'gene-locus',
    name: 'Gene locus',
    description: 'Synthetic genomic locus with spliced genes',
    seq,
    topology: 'linear',
    molecule: 'DNA',
    features: [
      f('p1', 'promoter', 'Promoter', 1, [[420, 900]]),
      f('g1', 'gene', 'ABC1', 1, [[900, 6900]]),
      f('m1', 'mRNA', 'ABC1-201', 1, exonsA),
      f('c1', 'CDS', 'ABC1 protein', 1, [[1080, 1240], [2010, 2290], [3400, 3910], [5020, 5330], [6150, 6420]]),
      f('pa1', 'polyA_signal', 'polyA', 1, [[6870, 6876]]),
      // custom colours from a file: dark fills get light label text
      { ...f('r1', 'repeat_region', 'Alu', 0, [[7300, 7610]]), color: '#7a3b69' },
      f('g2', 'gene', 'XYZ2', -1, [[8100, 11300]]),
      f('m2', 'mRNA', 'XYZ2-201', -1, exonsB),
      { ...f('c2', 'CDS', 'XYZ2 protein', -1, [[8400, 8600], [9250, 9500], [10400, 11020]]), color: '#2f4b9a' },
    ],
    primers: [],
    meta: {},
  };
}

/** Simple six-frame ORF scan (ATG..stop, at least `minAa` codons) for demos. */
export function demoOrfs(seq: string, minAa = 120): Orf[] {
  const out: Orf[] = [];
  const L = seq.length;
  const scan = (s: string, strand: 1 | -1) => {
    for (let frame = 0; frame < 3; frame++) {
      let start = -1;
      for (let i = frame; i + 3 <= s.length; i += 3) {
        const c = s.slice(i, i + 3);
        if (start < 0) {
          if (c === 'ATG') start = i;
        } else if (c === 'TAA' || c === 'TAG' || c === 'TGA') {
          const aa = (i - start) / 3;
          if (aa >= minAa) {
            const end = i + 3;
            out.push({
              range: strand === 1 ? { start, end } : { start: L - end, end: L - start },
              strand,
              frame: frame as 0 | 1 | 2,
              aaLength: aa,
              hasStop: true,
            });
          }
          start = -1;
        }
      }
    }
  };
  scan(seq, 1);
  scan(reverseComplement(seq), -1);
  return out;
}

/** Primers (with binding sites) placed on a record for demos: tails, a mismatch, a wrap. */
export function demoPrimers(
  record: SeqRecord,
  specs: Array<{ name: string; start: number; end: number; strand: 1 | -1; tail?: string; mismatches?: number; tm?: number }>,
): { record: SeqRecord; primerSites: PrimerBindingSite[] } {
  const L = record.seq.length;
  const primers: Primer[] = [];
  const primerSites: PrimerBindingSite[] = [];
  specs.forEach((s, i) => {
    const id = `${record.id}-p${i + 1}`;
    const annealed =
      s.end <= L ? record.seq.slice(s.start, s.end) : record.seq.slice(s.start) + record.seq.slice(0, s.end - L);
    const oligo = (s.tail ?? '') + (s.strand === 1 ? annealed : reverseComplement(annealed));
    primers.push({ id, name: s.name, sequence: oligo });
    primerSites.push({
      primerId: id,
      strand: s.strand,
      range: { start: s.start, end: s.end },
      annealedLength: s.end - s.start,
      mismatches: s.mismatches ?? 0,
      tailLength: s.tail?.length ?? 0,
      tm: s.tm,
    });
  });
  return { record: { ...record, primers: [...record.primers, ...primers] }, primerSites };
}
