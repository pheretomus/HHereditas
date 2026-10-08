/**
 * Gallery-only data for the circular map: a tiny restriction-site scanner (so stories can show
 * "all enzymes" on a real sequence without depending on the core enzyme module), hand-made
 * ORFs and a synthetic bacterial genome for performance checks. Not exported from the package.
 */
import type { EnzymeSite, Feature, Orf, SeqRecord, Strand } from '@hhereditas/core';
import { reverseComplement } from '@hhereditas/core';

/** name, recognition site (IUPAC), top / bottom cut offsets from the site start (top strand). */
type EnzymeDef = readonly [string, string, number, number];

/** Common commercial enzymes (palindromes and a few Type IIS). */
export const COMMON_ENZYMES: readonly EnzymeDef[] = [
  ['AatII', 'GACGTC', 5, 1],
  ['AclI', 'AACGTT', 2, 4],
  ['AfeI', 'AGCGCT', 3, 3],
  ['AflII', 'CTTAAG', 1, 5],
  ['AgeI', 'ACCGGT', 1, 5],
  ['ApaI', 'GGGCCC', 5, 1],
  ['ApaLI', 'GTGCAC', 1, 5],
  ['AscI', 'GGCGCGCC', 2, 6],
  ['AseI', 'ATTAAT', 2, 4],
  ['AvaI', 'CYCGRG', 1, 5],
  ['AvrII', 'CCTAGG', 1, 5],
  ['BamHI', 'GGATCC', 1, 5],
  ['BclI', 'TGATCA', 1, 5],
  ['BglII', 'AGATCT', 1, 5],
  ['BsaAI', 'YACGTR', 3, 3],
  ['BsiWI', 'CGTACG', 1, 5],
  ['BspHI', 'TCATGA', 1, 5],
  ['BsrGI', 'TGTACA', 1, 5],
  ['BssHII', 'GCGCGC', 1, 5],
  ['BstBI', 'TTCGAA', 2, 4],
  ['BstZ17I', 'GTATAC', 3, 3],
  ['ClaI', 'ATCGAT', 2, 4],
  ['DraI', 'TTTAAA', 3, 3],
  ['EagI', 'CGGCCG', 1, 5],
  ['EcoRI', 'GAATTC', 1, 5],
  ['EcoRV', 'GATATC', 3, 3],
  ['FseI', 'GGCCGGCC', 6, 2],
  ['FspI', 'TGCGCA', 3, 3],
  ['HindIII', 'AAGCTT', 1, 5],
  ['HpaI', 'GTTAAC', 3, 3],
  ['KasI', 'GGCGCC', 1, 5],
  ['KpnI', 'GGTACC', 5, 1],
  ['MfeI', 'CAATTG', 1, 5],
  ['MluI', 'ACGCGT', 1, 5],
  ['MscI', 'TGGCCA', 3, 3],
  ['NaeI', 'GCCGGC', 3, 3],
  ['NarI', 'GGCGCC', 2, 4],
  ['NcoI', 'CCATGG', 1, 5],
  ['NdeI', 'CATATG', 2, 4],
  ['NheI', 'GCTAGC', 1, 5],
  ['NotI', 'GCGGCCGC', 2, 6],
  ['NruI', 'TCGCGA', 3, 3],
  ['NsiI', 'ATGCAT', 5, 1],
  ['PacI', 'TTAATTAA', 5, 3],
  ['PciI', 'ACATGT', 1, 5],
  ['PmeI', 'GTTTAAAC', 4, 4],
  ['PmlI', 'CACGTG', 3, 3],
  ['PsiI', 'TTATAA', 3, 3],
  ['PstI', 'CTGCAG', 5, 1],
  ['PvuI', 'CGATCG', 4, 2],
  ['PvuII', 'CAGCTG', 3, 3],
  ['SacI', 'GAGCTC', 5, 1],
  ['SacII', 'CCGCGG', 4, 2],
  ['SalI', 'GTCGAC', 1, 5],
  ['ScaI', 'AGTACT', 3, 3],
  ['SfoI', 'GGCGCC', 3, 3],
  ['SmaI', 'CCCGGG', 3, 3],
  ['SnaBI', 'TACGTA', 3, 3],
  ['SpeI', 'ACTAGT', 1, 5],
  ['SphI', 'GCATGC', 5, 1],
  ['SspI', 'AATATT', 3, 3],
  ['StuI', 'AGGCCT', 3, 3],
  ['SwaI', 'ATTTAAAT', 4, 4],
  ['XbaI', 'TCTAGA', 1, 5],
  ['XhoI', 'CTCGAG', 1, 5],
  ['XmaI', 'CCCGGG', 1, 5],
  ['ZraI', 'GACGTC', 3, 3],
  ['BsaI', 'GGTCTC', 7, 11],
  ['BsmBI', 'CGTCTC', 7, 11],
  ['BbsI', 'GAAGAC', 8, 12],
  ['SapI', 'GCTCTTC', 8, 11],
  ['EarI', 'CTCTTC', 7, 10],
];

const IUPAC: Record<string, string> = {
  A: 'A',
  C: 'C',
  G: 'G',
  T: 'T',
  R: '[AG]',
  Y: '[CT]',
  S: '[CG]',
  W: '[AT]',
  K: '[GT]',
  M: '[AC]',
  B: '[CGT]',
  D: '[AGT]',
  H: '[ACT]',
  V: '[ACG]',
  N: '[ACGT]',
};

/** All sites of the given enzymes on a record (both strands, wrapping the origin when circular). */
export function scanSites(record: SeqRecord, enzymes: readonly EnzymeDef[] = COMMON_ENZYMES): EnzymeSite[] {
  const seq = record.seq;
  const L = seq.length;
  const circular = record.topology === 'circular';
  const sites: EnzymeSite[] = [];
  for (const [enzyme, site, top, bottom] of enzymes) {
    const n = site.length;
    const text = circular ? seq + seq.slice(0, n - 1) : seq;
    const rc = reverseComplement(site);
    const strands: Array<[string, 1 | -1]> = rc === site ? [[site, 1]] : [
      [site, 1],
      [rc, -1],
    ];
    for (const [pattern, strand] of strands) {
      const re = new RegExp(`(?=${[...pattern].map((c) => IUPAC[c] ?? c).join('')})`, 'g');
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const start = m.index;
        if (start >= L) break;
        re.lastIndex = start + 1;
        const t = strand === 1 ? top : n - bottom;
        const b = strand === 1 ? bottom : n - top;
        const norm = (p: number) => (circular ? ((p % L) + L) % L : p);
        const cuts = [{ top: norm(start + t), bottom: norm(start + b) }].filter(
          (c) => circular || (c.top > 0 && c.top < L),
        );
        sites.push({ enzyme, range: { start, end: start + n }, strand, cuts });
      }
    }
  }
  return sites.sort((a, b) => a.range.start - b.range.start || (a.enzyme < b.enzyme ? -1 : 1));
}

/** Only the sites of enzymes that cut at most `max` times (what an app filter would pass). */
export function cuttingAtMost(sites: readonly EnzymeSite[], max: number): EnzymeSite[] {
  const count = new Map<string, number>();
  for (const s of sites) count.set(s.enzyme, (count.get(s.enzyme) ?? 0) + s.cuts.length);
  return sites.filter((s) => (count.get(s.enzyme) ?? 0) <= max);
}

export function makeOrf(start: number, end: number, strand: 1 | -1, length: number, hasStop = true): Orf {
  const frame = ((strand === 1 ? start : length - (end % length)) % 3) as 0 | 1 | 2;
  return { range: { start, end }, strand, frame, aaLength: Math.floor((end - start) / 3) - (hasStop ? 1 : 0), hasStop };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic 4.6 Mb bacterial genome with ~4,500 features (performance story). */
export function makeGenome(): { record: SeqRecord; enzymeSites: EnzymeSite[] } {
  const L = 4_641_652;
  const rand = rng(7);
  const chunk = 'ACGTTGCAAGCTTGGATCCGAATTCTGCAGGTACCATGGCTAGCTCGAGT';
  const seq = chunk.repeat(Math.ceil(L / chunk.length)).slice(0, L);
  const features: Feature[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let pos = 190;
  let n = 0;
  while (pos < L - 3000 && features.length < 4500) {
    const len = 300 + Math.floor(rand() * 2400);
    const strand: Strand = rand() < 0.5 ? 1 : -1;
    const name = `${letters[Math.floor(rand() * 26)]}${letters[Math.floor(rand() * 26)]}${letters[Math.floor(rand() * 26)]}${String.fromCharCode(65 + (n % 26))}`;
    const type = rand() < 0.02 ? 'rRNA' : rand() < 0.03 ? 'tRNA' : 'CDS';
    features.push({ id: `g${n}`, type, name, strand, segments: [{ start: pos, end: pos + len }], qualifiers: [{ key: 'gene', value: name }] });
    // Occasional overlapping regulatory annotations.
    if (rand() < 0.08) {
      features.push({
        id: `r${n}`,
        type: 'promoter',
        name: `P${name}`,
        strand,
        segments: [{ start: Math.max(0, pos - 80), end: pos + 20 }],
        qualifiers: [],
      });
    }
    pos += len + Math.floor(rand() * 400) - 60;
    n++;
  }
  const enzymeSites: EnzymeSite[] = ['NotI', 'SfiI', 'AscI', 'PacI', 'SwaI', 'PmeI', 'SrfI', 'FseI'].flatMap((enzyme, i) =>
    Array.from({ length: i < 4 ? 1 : 2 }, (_, k) => {
      const start = Math.floor(rand() * (L - 10));
      return { enzyme, range: { start, end: start + 8 }, strand: 1 as const, cuts: [{ top: start + 2 + k, bottom: start + 6 }] };
    }),
  );
  return {
    record: {
      id: 'genome',
      name: 'Escherichia coli K-12 (synthetic)',
      description: '',
      seq,
      topology: 'circular',
      molecule: 'DNA',
      features,
      primers: [],
      meta: {},
    },
    enzymeSites,
  };
}
