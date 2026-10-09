import { describe, expect, it } from 'vitest';
import {
  ECOLI_PATH,
  FIXTURES_DIR,
  fileExists,
  genbankSequence,
  instantiate,
  mulberry32,
  plant,
  randInt,
  randomDna,
  resultObjectProblems,
  rotate,
} from '../../test/oracle/enzymes/load';
import type { CutPair, DnaEnd, EnzymeSite, FragmentEnds, Topology } from '../types';
import { iupacMatches, reverseComplement } from '../seq/alphabet';
import { mod, sliceRange } from '../seq/range';
import { COMMON_ENZYMES, ENZYMES, getEnzyme, isPalindromic, makeEnzyme } from './enzyme';
import type { RestrictionEnzyme } from './enzyme';
import { digest, digestDetailed } from './digest';
import { compareSites, countCuts, countSites, findSites, findSitesForEnzyme } from './search';

function E(name: string): RestrictionEnzyme {
  const e = getEnzyme(name);
  if (e === undefined) throw new Error(`missing enzyme ${name}`);
  return e;
}

const PUC19 = genbankSequence(`${FIXTURES_DIR}/genbank/pUC19_M77789.gb`);

/** Straightforward reference: test every start position and orientation base by base. */
function bruteForceSites(seq: string, topology: Topology, enzyme: RestrictionEnzyme): EnzymeSite[] {
  const target = seq.toUpperCase();
  const L = target.length;
  const site = enzyme.site;
  const n = site.length;
  const palindromic = isPalindromic(site);
  const readings: Array<[string, 1 | -1]> = palindromic ? [[site, 1]] : [[site, 1], [reverseComplement(site), -1]];
  const limit = topology === 'circular' ? (n <= L ? L : 0) : L - n + 1;
  const out: EnzymeSite[] = [];
  for (let p = 0; p < limit; p++) {
    for (const [pattern, strand] of readings) {
      let ok = true;
      for (let j = 0; j < n && ok; j++) {
        const base = target[(p + j) % L];
        ok = 'ACGT'.includes(base) && iupacMatches(pattern[j], base);
      }
      if (!ok) continue;
      const events: Array<{ top: number; bottom: number }> = [];
      for (const c of enzyme.cuts) {
        if (strand === 1) events.push({ top: p + c.top, bottom: p + c.bottom });
        else events.push({ top: p + n - c.bottom, bottom: p + n - c.top });
        if (palindromic) events.push({ top: p + n - c.bottom, bottom: p + n - c.top });
      }
      // one entry per distinct double-strand break (after reduction modulo L on circles; written
      // without the shared mod(), which returns -0 for negative multiples of L: positions are +0)
      const wrap = (x: number) => ((x % L) + L) % L;
      const seen = new Set<string>();
      const cuts: CutPair[] = [];
      for (const ev of events.sort((a, b) => Math.min(a.top, a.bottom) - Math.min(b.top, b.bottom) || Math.max(a.top, a.bottom) - Math.max(b.top, b.bottom) || a.top - b.top)) {
        const cut = topology === 'circular' ? { top: wrap(ev.top), bottom: wrap(ev.bottom) } : ev;
        const key = `${cut.top},${cut.bottom}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (topology === 'circular' || (ev.top >= 1 && ev.top <= L - 1 && ev.bottom >= 1 && ev.bottom <= L - 1)) cuts.push(cut);
      }
      out.push({ enzyme: enzyme.name, range: { start: p, end: p + n }, strand, cuts });
    }
  }
  return out.sort(compareSites);
}

/** The text the site footprint covers, read 5'->3' along the site's own strand. */
function siteText(seq: string, site: EnzymeSite): string {
  const top = sliceRange(seq, site.range);
  return site.strand === 1 ? top : reverseComplement(top);
}

describe('findSites: hand-checked examples', () => {
  it('finds the single EcoRI site of pUC19 at the end of the annotated polylinker', () => {
    // M77789 annotates the polylinker as 233..289 "HindIII-SphI-PstI-SalI-XbaI-BamHI-SmaI-KpnI-SacI-EcoRI"
    expect(PUC19).toHaveLength(2686);
    const sites = findSitesForEnzyme(PUC19, 'circular', E('EcoRI'));
    expect(sites).toEqual([{ enzyme: 'EcoRI', range: { start: 283, end: 289 }, strand: 1, cuts: [{ top: 284, bottom: 288 }] }]);
    expect(sliceRange(PUC19, sites[0].range)).toBe('GAATTC');
    const order = ['HindIII', 'SphI', 'PstI', 'SalI', 'XbaI', 'BamHI', 'SmaI', 'KpnI', 'SacI', 'EcoRI'];
    const mcs = findSites(PUC19, 'circular', order.map(E));
    expect(mcs.map((s) => s.enzyme)).toEqual(order); // each a unique site, in annotation order
    expect(mcs[0].range).toEqual({ start: 232, end: 238 }); // HindIII AAGCTT opens the polylinker
    expect(mcs.every((s) => s.range.start >= 232 && s.range.end <= 289)).toBe(true);
    // the same molecule read as linear gives the same single site
    expect(findSitesForEnzyme(PUC19, 'linear', E('EcoRI'))).toEqual(sites);
  });

  it('reports BsaI on both strands with mirrored cuts', () => {
    //             0         1         2         3
    //             0123456789012345678901234567890123
    const seq = 'AAAAGGTCTCAAAAAAAAAAAAAGAGACCAAAA';
    const sites = findSitesForEnzyme(seq, 'linear', E('BsaI'));
    // GGTCTC(1/5) at 4: top cut 4 + 7 = 11, bottom 4 + 11 = 15 (5' overhang 11..14 'AAAA')
    // GAGACC at 23 (site on the bottom strand): top = 23 + 6 - 11 = 18, bottom = 23 + 6 - 7 = 22
    expect(sites).toEqual([
      { enzyme: 'BsaI', range: { start: 4, end: 10 }, strand: 1, cuts: [{ top: 11, bottom: 15 }] },
      { enzyme: 'BsaI', range: { start: 23, end: 29 }, strand: -1, cuts: [{ top: 18, bottom: 22 }] },
    ]);
    expect(siteText(seq, sites[1])).toBe('GGTCTC');
  });

  it('reports PstI 3prime and SmaI blunt cuts', () => {
    expect(findSitesForEnzyme('AAACTGCAGAAA', 'linear', E('PstI'))).toEqual([
      { enzyme: 'PstI', range: { start: 3, end: 9 }, strand: 1, cuts: [{ top: 8, bottom: 4 }] },
    ]);
    expect(findSitesForEnzyme('AAACCCGGGAAA', 'linear', E('SmaI'))).toEqual([
      { enzyme: 'SmaI', range: { start: 3, end: 9 }, strand: 1, cuts: [{ top: 6, bottom: 6 }] },
    ]);
    // XmaI recognises the same site but cuts C^CCGGG
    expect(findSitesForEnzyme('AAACCCGGGAAA', 'linear', E('XmaI'))[0].cuts).toEqual([{ top: 4, bottom: 8 }]);
  });

  it('finds overlapping occurrences', () => {
    const hhaI = findSitesForEnzyme('AGCGCGCGCA', 'linear', E('HhaI')); // GCG^C
    expect(hhaI.map((s) => s.range.start)).toEqual([1, 3, 5]);
    const mnlI = findSitesForEnzyme('ACCTCCTCA', 'linear', E('MnlI')); // CCTC(7/6), non-palindromic
    expect(mnlI.map((s) => [s.range.start, s.strand])).toEqual([
      [1, 1],
      [4, 1],
    ]);
    const aluI = findSites('AGCTAGCT', 'circular', [E('AluI')]);
    expect(aluI.map((s) => s.range)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ]);
  });

  it('finds sites spanning the origin of circular molecules only', () => {
    // GAATTC split as ...GAA | TTC...
    const seq = 'TTCAAGAA';
    expect(findSitesForEnzyme(seq, 'linear', E('EcoRI'))).toEqual([]);
    expect(findSitesForEnzyme(seq, 'circular', E('EcoRI'))).toEqual([
      { enzyme: 'EcoRI', range: { start: 5, end: 11 }, strand: 1, cuts: [{ top: 6, bottom: 2 }] },
    ]);
    // a reverse BsaI site spanning the origin: GAGACC = GAG | ACC
    const bsa = 'ACCTTTTTTTTTTTTTTTTTGAG';
    const sites = findSitesForEnzyme(bsa, 'circular', E('BsaI'));
    expect(sites).toEqual([{ enzyme: 'BsaI', range: { start: 20, end: 26 }, strand: -1, cuts: [{ top: 15, bottom: 19 }] }]);
    expect(siteText(bsa, sites[0])).toBe('GGTCTC');
  });

  it('normalizes circular cuts that wrap the origin into [0, L)', () => {
    // 20-bp circle 'CTC' + A*14 + 'GGT': BsaI site at 17 spans the origin;
    // top cut 17 + 7 = 24 -> 4, bottom 17 + 11 = 28 -> 8
    const seq = plant('A'.repeat(20), 17, 'GGTCTC');
    expect(seq).toBe('CTC' + 'A'.repeat(14) + 'GGT');
    const sites = findSitesForEnzyme(seq, 'circular', E('BsaI'));
    expect(sites).toEqual([{ enzyme: 'BsaI', range: { start: 17, end: 23 }, strand: 1, cuts: [{ top: 4, bottom: 8 }] }]);
  });

  it('never matches ambiguous target bases, even under an N of the site', () => {
    expect(findSitesForEnzyme('AAGAANTCAA', 'linear', E('EcoRI'))).toEqual([]);
    expect(findSitesForEnzyme('AAGARTTCAA', 'linear', E('EcoRI'))).toEqual([]);
    expect(findSitesForEnzyme('AGCCNNNNNGGCA', 'linear', E('BglI'))).toEqual([]);
    expect(findSitesForEnzyme('AGCCAANAAGGCA', 'linear', E('BglI'))).toEqual([]);
    expect(findSitesForEnzyme('AGCCAATAAGGCA', 'linear', E('BglI'))).toHaveLength(1);
    expect(findSitesForEnzyme('NNNNNNNNNNNN', 'circular', E('MspJI'))).toEqual([]);
    expect(findSitesForEnzyme('GAA-TTC GAATTC', 'linear', E('EcoRI')).map((s) => s.range.start)).toEqual([8]);
  });

  it('matches degenerate recognition sequences', () => {
    // AvaI C^YCGRG: CTCGAG (XhoI site) and CCCGGG (SmaI site) both match, CACGAG does not
    expect(findSitesForEnzyme('ACTCGAGTTCCCGGGTTCACGAGT', 'linear', E('AvaI')).map((s) => s.range.start)).toEqual([1, 9]);
    // ApoI R^AATTY
    expect(findSitesForEnzyme('GAATTTxAAATTCxGAATTA', 'linear', E('ApoI')).map((s) => s.range.start)).toEqual([0, 7]);
  });

  it('tolerates lower-case and mixed-case input', () => {
    const upper = findSitesForEnzyme('AAGAATTCAA', 'linear', E('EcoRI'));
    expect(findSitesForEnzyme('aagaattcaa', 'linear', E('EcoRI'))).toEqual(upper);
    expect(findSitesForEnzyme('aaGaAtTcaa', 'linear', E('EcoRI'))).toEqual(upper);
  });

  it('keeps coordinates of non-ASCII input stable', () => {
    // 'ß'.toUpperCase() is 'SS': a naive upper-casing would shift the site by one base
    expect(findSitesForEnzyme('ßAGAATTC', 'linear', E('EcoRI'))[0].range).toEqual({ start: 2, end: 8 });
  });

  it('handles empty and tiny molecules', () => {
    for (const topology of ['linear', 'circular'] as const) {
      expect(findSites('', topology, ENZYMES)).toEqual([]);
      expect(findSites('A', topology, [E('EcoRI'), E('AbaSI')])).toEqual([]);
    }
    // a 1-base site on a 1-base molecule: AbaSI C(11/9) is found, its cuts fall outside
    expect(findSitesForEnzyme('C', 'linear', E('AbaSI'))).toEqual([{ enzyme: 'AbaSI', range: { start: 0, end: 1 }, strand: 1, cuts: [] }]);
    expect(findSitesForEnzyme('G', 'linear', E('AbaSI'))).toEqual([{ enzyme: 'AbaSI', range: { start: 0, end: 1 }, strand: -1, cuts: [] }]);
    // a circular molecule shorter than the site is not searched for it
    expect(findSitesForEnzyme('GAATT', 'circular', E('EcoRI'))).toEqual([]);
    expect(findSitesForEnzyme('GAATTC', 'circular', E('EcoRI'))).toEqual([
      { enzyme: 'EcoRI', range: { start: 0, end: 6 }, strand: 1, cuts: [{ top: 1, bottom: 5 }] },
    ]);
  });
});

describe('findSites: linear ends (Biopython rule)', () => {
  it('keeps events whose cuts are both in [1, L - 1]', () => {
    // EcoRI site at 0: top cut at gap 1 (inside), bottom at 5
    expect(findSitesForEnzyme('GAATTCAA', 'linear', E('EcoRI'))[0].cuts).toEqual([{ top: 1, bottom: 5 }]);
    // EcoRI at the very end: GAATTC at 2..8 of an 8-mer -> top 3, bottom 7 = L - 1
    expect(findSitesForEnzyme('AAGAATTC', 'linear', E('EcoRI'))[0].cuts).toEqual([{ top: 3, bottom: 7 }]);
  });

  it('drops events with a cut exactly at gap 0 or L, or outside, but lists the site', () => {
    // MboI ^GATC at 0: top cut at gap 0
    expect(findSitesForEnzyme('GATCAAAA', 'linear', E('MboI'))).toEqual([{ enzyme: 'MboI', range: { start: 0, end: 4 }, strand: 1, cuts: [] }]);
    // NlaIII CATG^ at the end: top cut at gap L
    expect(findSitesForEnzyme('AAAACATG', 'linear', E('NlaIII'))[0].cuts).toEqual([]);
    // BsaI near the end: cuts beyond the molecule
    expect(findSitesForEnzyme('AAGGTCTCAA', 'linear', E('BsaI'))).toEqual([{ enzyme: 'BsaI', range: { start: 2, end: 8 }, strand: 1, cuts: [] }]);
    // the same molecule circularised cleaves
    expect(findSitesForEnzyme('AAGGTCTCAA', 'circular', E('BsaI'))[0].cuts).toEqual([{ top: 9, bottom: 3 }]);
  });

  it('filters each event of a two-cut enzyme separately', () => {
    // BaeI (10/15)ACNNNNGTAYC(12/7): left event needs 15 bases before the site, right 12 after
    const site = 'ACAAAAGTATC';
    // site at 15: left event (5, 0) has its bottom cut at gap 0, right event (38, 33) lies beyond L = 31
    const none = findSitesForEnzyme('T'.repeat(15) + site + 'T'.repeat(5), 'linear', E('BaeI'));
    expect(none).toEqual([{ enzyme: 'BaeI', range: { start: 15, end: 26 }, strand: 1, cuts: [] }]);
    // site at 16, L = 40: (6, 1) and (39, 34) are both inside [1, L - 1]
    const both = findSitesForEnzyme('T'.repeat(16) + site + 'T'.repeat(13), 'linear', E('BaeI'));
    expect(both[0].cuts).toEqual([
      { top: 6, bottom: 1 },
      { top: 39, bottom: 34 },
    ]);
    // L = 39: the right event's top cut falls exactly at gap L
    const leftOnly = findSitesForEnzyme('T'.repeat(16) + site + 'T'.repeat(12), 'linear', E('BaeI'));
    expect(leftOnly[0].cuts).toEqual([{ top: 6, bottom: 1 }]);
  });
});

describe('findSites: special enzymes', () => {
  it('cuts on both sides for two-cut enzymes, mirrored on the bottom strand', () => {
    const fwd = 'T'.repeat(20) + 'ACAAAAGTATC' + 'T'.repeat(20);
    expect(findSitesForEnzyme(fwd, 'linear', E('BaeI'))).toEqual([
      { enzyme: 'BaeI', range: { start: 20, end: 31 }, strand: 1, cuts: [{ top: 10, bottom: 5 }, { top: 43, bottom: 38 }] },
    ]);
    const rev = 'T'.repeat(20) + reverseComplement('ACAAAAGTATC') + 'T'.repeat(20);
    // mirrored: (t, b) -> (p + n - b, p + n - t) = (31 - 18, 31 - 23) and (31 + 15, 31 + 10)
    expect(findSitesForEnzyme(rev, 'linear', E('BaeI'))).toEqual([
      { enzyme: 'BaeI', range: { start: 20, end: 31 }, strand: -1, cuts: [{ top: 13, bottom: 8 }, { top: 46, bottom: 41 }] },
    ]);
  });

  it('applies both readings of palindromic sites with asymmetric cleavage (SgeI)', () => {
    // SgeI CNNG(9/13): cut 9/13 after the site in either orientation
    const seq = 'T'.repeat(20) + 'CAAG' + 'T'.repeat(20);
    expect(findSitesForEnzyme(seq, 'linear', E('SgeI'))).toEqual([
      { enzyme: 'SgeI', range: { start: 20, end: 24 }, strand: 1, cuts: [{ top: 7, bottom: 11 }, { top: 33, bottom: 37 }] },
    ]);
  });

  it('reports both orientations where a degenerate non-palindromic site matches both ways (MspJI)', () => {
    // CNNR / YNNG: CAAG matches CNNR (R = G) and YNNG (Y = C)
    const sites = findSitesForEnzyme('T'.repeat(20) + 'CAAG' + 'T'.repeat(20), 'linear', E('MspJI'));
    expect(sites.map((s) => [s.range.start, s.strand])).toEqual([
      [20, 1],
      [20, -1],
    ]);
  });

  it('accepts user-defined enzymes with lower-case sites', () => {
    const custom = makeEnzyme({ name: 'MyEcoRI', site: 'gaattc', cuts: [{ top: 1, bottom: 5 }] });
    const plain = { name: 'Raw', site: 'gaattc', cuts: [{ top: 1, bottom: 5 }], suppliers: '', commercial: false };
    expect(findSitesForEnzyme('AAGAATTCAA', 'linear', custom)[0].range).toEqual({ start: 2, end: 8 });
    expect(findSitesForEnzyme('AAGAATTCAA', 'linear', plain)[0].cuts).toEqual([{ top: 3, bottom: 7 }]);
  });

  it('throws on invalid enzyme definitions', () => {
    const bad = { name: 'Bad', site: 'GAXTC', cuts: [{ top: 1, bottom: 3 }], suppliers: '', commercial: false };
    expect(() => findSites('GAATTC', 'linear', [bad])).toThrow(/Invalid enzyme 'Bad'/);
    expect(() => findSites('', 'linear', [bad])).toThrow(/Invalid enzyme 'Bad'/);
  });
});

describe('findSites: ordering and bookkeeping', () => {
  it('sorts by start, then enzyme name, then strand', () => {
    const seq = 'GGATCCAAGAATTCAAGGTCTCAAGAGACCAA';
    const sites = findSites(seq, 'linear', [E('EcoRI'), E('BsaI'), E('BamHI'), E('MboI'), E('BstYI')]);
    for (let i = 1; i < sites.length; i++) expect(compareSites(sites[i - 1], sites[i])).toBeLessThan(0);
    expect(sites.slice(0, 3).map((s) => s.enzyme)).toEqual(['BamHI', 'BstYI', 'MboI']);
  });

  it('ignores duplicate enzymes (by name)', () => {
    const once = findSites(PUC19, 'circular', [E('PvuII')]);
    expect(findSites(PUC19, 'circular', [E('PvuII'), E('PvuII')])).toEqual(once);
    expect(once).toHaveLength(2);
  });

  it('does not mutate its inputs', () => {
    const list = [E('EcoRI'), E('BsaI')];
    const copy = [...list];
    findSites('GAATTC', 'linear', list);
    expect(list).toEqual(copy);
  });

  it('counts distinct cleavage events and sites per enzyme', () => {
    const seq = 'AAGAATTCAA' + 'T'.repeat(16) + 'ACAAAAGTATC' + 'T'.repeat(16) + 'GATCAAA';
    const sites = findSites(seq, 'linear', [E('EcoRI'), E('BaeI'), E('MboI')]);
    const cuts = countCuts(sites);
    expect(cuts.get('EcoRI')).toBe(1);
    expect(cuts.get('BaeI')).toBe(2);
    expect(cuts.get('MboI')).toBe(1);
    expect(countSites(sites).get('BaeI')).toBe(1);
    // a site that cannot be cleaved counts 0 cuts
    expect(countCuts(findSites('GATCAAA', 'linear', [E('MboI')])).get('MboI')).toBe(0);
    // two sites producing the same double-strand break count once (MlyI GAGTC(5/5), blunt)
    const twin = findSitesForEnzyme('AAAA' + 'GAGTC' + 'AAAAA' + 'TTTTT' + 'GACTC' + 'AAAA', 'linear', E('MlyI'));
    expect(twin).toHaveLength(2);
    expect(twin[0].cuts).toEqual(twin[1].cuts);
    expect(countCuts(twin).get('MlyI')).toBe(1);
    expect(countCuts([])).toEqual(new Map());
  });
});

describe('findSites: properties on seeded random input', () => {
  const rand = mulberry32(0xe11e);
  const pick = () => ENZYMES[randInt(rand, 0, ENZYMES.length - 1)];

  it('agrees with a brute-force reference (random enzymes, sequences with N/R and lower case)', () => {
    for (let trial = 0; trial < 400; trial++) {
      const enzyme = pick();
      const L = randInt(rand, 0, 120);
      let seq = randomDna(L, rand, trial % 5 === 0 ? 'ACGTACGTACGTNRacgt' : 'ACGT');
      for (let k = 0; k < 3 && L > 0; k++) {
        let text = instantiate(enzyme.site, rand);
        if (rand() < 0.5) text = reverseComplement(text);
        if (text.length <= L) seq = plant(seq, randInt(rand, 0, L - 1), text);
      }
      for (const topology of ['linear', 'circular'] as const) {
        expect(findSitesForEnzyme(seq, topology, enzyme), `${enzyme.name} ${topology} ${seq}`).toEqual(bruteForceSites(seq, topology, enzyme));
      }
    }
  });

  it('handles fully degenerate user-defined sites (no A/C/G/T anchor)', () => {
    const custom = [
      makeEnzyme({ name: 'Deg1', site: 'RYNSW', cuts: [{ top: 2, bottom: 3 }] }),
      makeEnzyme({ name: 'Deg2', site: 'NNNN', cuts: [{ top: -3, bottom: 1 }] }),
      makeEnzyme({ name: 'Deg3', site: 'KMB', cuts: [{ top: 9, bottom: 8 }, { top: -2, bottom: -4 }] }),
    ];
    for (let trial = 0; trial < 60; trial++) {
      const seq = randomDna(randInt(rand, 0, 60), rand, 'ACGTACGTN');
      for (const enzyme of custom) {
        for (const topology of ['linear', 'circular'] as const) {
          expect(findSitesForEnzyme(seq, topology, enzyme), `${enzyme.name} ${topology} ${seq}`).toEqual(bruteForceSites(seq, topology, enzyme));
        }
      }
    }
  });

  it('every reported footprint reads as the recognition sequence on its strand', () => {
    const seq = randomDna(2000, rand);
    const sites = findSites(seq, 'circular', ENZYMES);
    expect(sites.length).toBeGreaterThan(5000);
    for (const site of sites) {
      const text = siteText(seq, site);
      const pattern = E(site.enzyme).site;
      expect([...text].every((b, j) => iupacMatches(pattern[j], b)), `${site.enzyme} at ${site.range.start}`).toBe(true);
    }
  });

  it('is invariant under rotation of a circular molecule', () => {
    const enzymes = [E('EcoRI'), E('BsaI'), E('BaeI'), E('PstI'), E('AvaI'), E('MmeI'), E('SgeI'), E('HinfI')];
    for (let trial = 0; trial < 40; trial++) {
      const L = randInt(rand, 30, 400);
      let seq = randomDna(L, rand);
      for (const e of enzymes) seq = plant(seq, randInt(rand, 0, L - 1), rand() < 0.5 ? e.site.replace(/N/g, 'A') : reverseComplement(e.site.replace(/N/g, 'A')));
      const k = randInt(rand, 0, L - 1);
      const shift = (s: EnzymeSite): EnzymeSite => ({
        enzyme: s.enzyme,
        range: { start: mod(s.range.start - k, L), end: mod(s.range.start - k, L) + (s.range.end - s.range.start) },
        strand: s.strand,
        cuts: s.cuts.map((c) => ({ top: mod(c.top - k, L), bottom: mod(c.bottom - k, L) })),
      });
      const expected = findSites(seq, 'circular', enzymes).map(shift).sort(compareSites);
      expect(findSites(rotate(seq, k), 'circular', enzymes)).toEqual(expected);
    }
  });

  it('is symmetric under reverse complement (strands swap, cuts mirror)', () => {
    const enzymes = [E('BsaI'), E('BaeI'), E('EcoRI'), E('PstI'), E('MmeI'), E('SapI'), E('SgeI'), E('BglI'), E('MspJI')];
    for (let trial = 0; trial < 40; trial++) {
      const L = randInt(rand, 40, 300);
      let seq = randomDna(L, rand);
      for (const e of enzymes) seq = plant(seq, randInt(rand, 0, L - 1), instantiate(e.site, rand));
      for (const topology of ['linear', 'circular'] as const) {
        const mirror = (s: EnzymeSite): EnzymeSite => {
          const n = s.range.end - s.range.start;
          const start = topology === 'circular' ? mod(L - s.range.end, L) : L - s.range.end;
          const flip = (p: number) => (topology === 'circular' ? mod(L - p, L) : L - p);
          return {
            enzyme: s.enzyme,
            range: { start, end: start + n },
            strand: isPalindromic(E(s.enzyme).site) ? 1 : (-s.strand as 1 | -1),
            cuts: s.cuts.map((c) => ({ top: flip(c.bottom), bottom: flip(c.top) })),
          };
        };
        const normalizeCuts = (s: EnzymeSite) => ({ ...s, cuts: [...s.cuts].sort((a, b) => a.top - b.top || a.bottom - b.bottom) });
        const expected = findSites(seq, topology, enzymes).map(mirror).map(normalizeCuts).sort(compareSites);
        const actual = findSites(reverseComplement(seq), topology, enzymes).map(normalizeCuts);
        expect(actual).toEqual(expected);
      }
    }
  });

  it('linear sites are the circular sites that do not span the origin', () => {
    for (let trial = 0; trial < 30; trial++) {
      const seq = randomDna(randInt(rand, 50, 500), rand);
      const L = seq.length;
      const linear = findSites(seq, 'linear', COMMON_ENZYMES);
      const circular = findSites(seq, 'circular', COMMON_ENZYMES);
      expect(linear.map((s) => [s.enzyme, s.range, s.strand])).toEqual(circular.filter((s) => s.range.end <= L).map((s) => [s.enzyme, s.range, s.strand]));
      const circularCuts = new Map(circular.map((s) => [`${s.enzyme}@${s.range.start}${s.strand}`, s.cuts]));
      for (const s of linear) {
        const all = circularCuts.get(`${s.enzyme}@${s.range.start}${s.strand}`) ?? [];
        for (const c of s.cuts) expect(all).toContainEqual(c);
      }
    }
  });
});

describe('findSites: performance', () => {
  const rand = mulberry32(42);

  it('searches all enzymes on a 10 kb plasmid quickly (target < 100 ms)', () => {
    const plasmid = randomDna(10_000, rand);
    findSites(plasmid, 'circular', ENZYMES); // warm-up (JIT)
    const t0 = performance.now();
    const sites = findSites(plasmid, 'circular', ENZYMES);
    const ms = performance.now() - t0;
    console.info(`all ${ENZYMES.length} enzymes on 10 kb: ${ms.toFixed(1)} ms, ${sites.length} sites`);
    expect(ms).toBeLessThan(1000);
  });

  it.skipIf(!fileExists(ECOLI_PATH))('searches the 4.6 Mb E. coli genome (targets: 1 enzyme < 300 ms, common enzymes < 5 s)', () => {
    const genome = genbankSequence(ECOLI_PATH);
    expect(genome).toHaveLength(4_641_652);
    findSitesForEnzyme(genome.slice(0, 100_000), 'circular', E('EcoRI')); // warm-up
    let t0 = performance.now();
    const ecoRI = findSitesForEnzyme(genome, 'circular', E('EcoRI'));
    const one = performance.now() - t0;
    t0 = performance.now();
    const common = findSites(genome, 'circular', COMMON_ENZYMES);
    const all = performance.now() - t0;
    console.info(`E. coli: EcoRI ${one.toFixed(0)} ms (${ecoRI.length} sites); ${COMMON_ENZYMES.length} common enzymes ${all.toFixed(0)} ms (${common.length} sites)`);
    expect(ecoRI.length).toBe(646); // Biopython 1.88 EcoRI.search(U00096.3, circular) also finds 646
    expect(one).toBeLessThan(3000);
    expect(all).toBeLessThan(20_000);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Regression tests for defects found by adversarial review
// ---------------------------------------------------------------------------

const blunt: DnaEnd = { kind: 'blunt', length: 0 };
const five = (length: number): DnaEnd => ({ kind: '5prime', length });
const three = (length: number): DnaEnd => ({ kind: '3prime', length });

/** Random end with an overhang of at most `room` bases (blunt when room < 1). */
function randomEnd(rand: () => number, room: number): DnaEnd {
  const kind = (['blunt', '5prime', '3prime'] as const)[randInt(rand, 0, 2)];
  return kind === 'blunt' || room < 1 ? blunt : { kind, length: randInt(rand, 1, room) };
}

/**
 * Every cleavage event of a site in molecule coordinates, before any end rule, computed from the
 * enzyme definition (strand -1: mirrored offsets; palindromic sites: both readings), once each.
 */
function allEvents(site: EnzymeSite, enzyme: RestrictionEnzyme = E(site.enzyme)): CutPair[] {
  const n = enzyme.site.length;
  const p = site.range.start;
  const palindromic = isPalindromic(enzyme.site);
  const events = new Map<string, CutPair>();
  for (const c of enzyme.cuts) {
    const forward = { top: p + c.top, bottom: p + c.bottom };
    const mirrored = { top: p + n - c.bottom, bottom: p + n - c.top };
    const readings = site.strand === -1 ? [mirrored] : palindromic ? [forward, mirrored] : [forward];
    for (const ev of readings) events.set(`${ev.top},${ev.bottom}`, ev);
  }
  return [...events.values()];
}

const byCut = (a: CutPair, b: CutPair) => a.top - b.top || a.bottom - b.bottom;

describe('review: findSites applies the sticky-end rule of digest to linear molecules given their ends', () => {
  // GFP start, cut out of a vector with EcoRI + XhoI for directional cloning: 5' AATT and TCGA overhangs
  const insert = 'ATGAGTAAAGGAGAAGAACTTTTCACTGGAGTTGTCCCAATTCTTGTTGAATTAGATGGTGATGTTAATGGGCACAAATTTTCTGTC';

  it('lists the TaqI site in the single-stranded TCGA overhang of an EcoRI-XhoI insert without a cleavage event', () => {
    expect(insert.includes('TCGA')).toBe(false); // no internal TaqI site
    const [, frag] = digest('GGGGG' + 'GAATTC' + insert + 'CTCGAG' + 'GGGGG', 'linear', [E('EcoRI'), E('XhoI')]);
    expect(frag.ends).toEqual({ left: five(4), right: five(4) });
    const L = frag.length;
    const enzymes = [E('TaqI'), E('EcoRI'), E('XhoI')];
    const sites = findSites(frag.seq, 'linear', enzymes, { ends: frag.ends });
    // the last 4 bases exist only on the bottom strand: the site text is there, TaqI cannot cut it
    expect(sites).toEqual([{ enzyme: 'TaqI', range: { start: L - 4, end: L }, strand: 1, cuts: [] }]);
    const report = digestDetailed(frag.seq, 'linear', [E('TaqI')], { ends: frag.ends });
    expect(report.fragments).toHaveLength(1);
    expect(report.skipped.map((s) => s.reason)).toEqual(['end']);
    expect(countCuts(sites).get('TaqI') ?? 0).toBe(report.fragments.length - 1);
    expect(findSitesForEnzyme(frag.seq, 'linear', E('TaqI'), { ends: frag.ends })).toEqual(sites);
    // without ends the molecule is taken as blunt-ended (documented default): TaqI then seems to cut once
    expect(countCuts(findSites(frag.seq, 'linear', enzymes)).get('TaqI')).toBe(1);
  });

  it('agrees with digest on common cloning ends whose overhang is a 4-cutter site', () => {
    // [enzyme making the ends, 4-cutters whose recognition sequence is that overhang]
    const cases: Array<[string, string[]]> = [
      ['XhoI', ['TaqI']], // C^TCGAG: 5' TCGA
      ['SalI', ['TaqI']], // G^TCGAC: 5' TCGA
      ['HindIII', ['AluI', 'CviKI-1']], // A^AGCTT: 5' AGCT
      ['SacI', ['AluI', 'CviKI-1']], // GAGCT^C: 3' AGCT
      ['XbaI', ['BfaI']], // T^CTAGA: 5' CTAG
      ['SpeI', ['BfaI']], // A^CTAGT: 5' CTAG
      ['NheI', ['BfaI']], // G^CTAGC: 5' CTAG
      ['NcoI', ['CviAII']], // C^CATGG: 5' CATG
      ['SphI', ['CviAII']], // GCATG^C: 3' CATG
      ['KpnI', ['RsaI', 'Csp6I']], // GGTAC^C: 3' GTAC
      ['PstI', ['HpyCH4V']], // CTGCA^G: 3' TGCA
      ['NotI', ['HaeIII']], // GC^GGCCGC: 5' GGCC
    ];
    const flank = 'A'.repeat(20);
    for (const [cutter, fourCutters] of cases) {
      const frags = digest(flank + E(cutter).site + flank + E(cutter).site + flank, 'linear', [E(cutter)]);
      expect(frags, cutter).toHaveLength(3);
      frags.forEach((frag, i) => {
        for (const name of fourCutters) {
          const label = `${name} on ${cutter} fragment ${i}`;
          const sites = findSites(frag.seq, 'linear', [E(name)], { ends: frag.ends });
          // the only sites are the overhangs (both ends of the middle fragment, one end of the others)
          expect(sites.map((s) => s.cuts), label).toEqual(i === 1 ? [[], []] : [[]]);
          expect(countCuts(sites).get(name), label).toBe(digest(frag.seq, 'linear', [E(name)], { ends: frag.ends }).length - 1);
          // read as a blunt-ended molecule, both overhang sites of the middle fragment would seem to cut
          if (i === 1) expect(countCuts(findSites(frag.seq, 'linear', [E(name)])).get(name), label).toBe(2);
        }
      });
    }
  });

  it('validates the ends like digest, ignores them on circles and treats blunt ends as the default', () => {
    const seq = 'GATCAAAAGAATTCAAAAGATC'; // 22 bases
    const enzymes = [E('MboI'), E('EcoRI'), E('DpnI')];
    const plain = findSites(seq, 'linear', enzymes);
    // MboI ^GATC cuts at gap 0 (site at 0) and gap L (site at 18): not cleaved (Biopython rule)
    expect(plain.map((s) => [s.enzyme, s.range.start, s.cuts.length])).toEqual([
      ['DpnI', 0, 1],
      ['MboI', 0, 0],
      ['EcoRI', 8, 1],
      ['DpnI', 18, 1],
      ['MboI', 18, 0],
    ]);
    expect(findSites(seq, 'linear', enzymes, {})).toEqual(plain);
    expect(findSites(seq, 'linear', enzymes, { ends: { left: blunt, right: blunt } })).toEqual(plain);
    expect(findSites(seq, 'linear', enzymes, { ends: { left: five(0), right: three(0) } })).toEqual(plain);
    // one unpaired base at each end: the DpnI cuts (gaps 2 and 20) still leave a base pair on each
    // side, but neither GATC site is fully double-stranded any more, so DpnI cannot cut
    const sticky = findSites(seq, 'linear', enzymes, { ends: { left: five(1), right: three(1) } });
    expect(sticky.map((s) => [s.enzyme, s.range.start, s.cuts.length])).toEqual([
      ['DpnI', 0, 0],
      ['MboI', 0, 0],
      ['EcoRI', 8, 1],
      ['DpnI', 18, 0],
      ['MboI', 18, 0],
    ]);
    expect(digest(seq, 'linear', [E('DpnI')], { ends: { left: five(1), right: three(1) } })).toHaveLength(1);
    const ends = { left: five(9), right: three(3) };
    expect(findSites(seq, 'circular', enzymes, { ends })).toEqual(findSites(seq, 'circular', enzymes));
    expect(findSites('', 'linear', enzymes, { ends })).toEqual([]);
    const invalid: FragmentEnds[] = [
      { left: five(12), right: three(10) }, // no base pair left
      { left: five(23), right: blunt }, // longer than the molecule
      { left: five(-1), right: blunt },
      { left: three(1.5), right: blunt },
      { left: { kind: 'blunt', length: 2 }, right: blunt },
      { left: { kind: 'sticky', length: 1 } as unknown as DnaEnd, right: blunt },
    ];
    for (const bad of invalid) {
      let message = '';
      try {
        digest(seq, 'linear', enzymes, { ends: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(bad)).not.toBe('');
      expect(() => findSites(seq, 'linear', enzymes, { ends: bad }), JSON.stringify(bad)).toThrow(message);
    }
  });

  it('keeps exactly the events with a base pair to spare inside the duplex and a fully double-stranded site, like digest', () => {
    const rand = mulberry32(0x57e4d5);
    const pool = ['EcoRI', 'BamHI', 'MboI', 'TaqI', 'AluI', 'PstI', 'KpnI', 'SmaI', 'BsaI', 'BsmBI', 'SapI', 'BaeI', 'CspCI', 'MmeI',
      'MlyI', 'HinfI', 'BglI', 'SgeI', 'MspJI', 'TspRI', 'NlaIII', 'AbaSI'].map(E);
    let kept = 0;
    let dropped = 0;
    for (let trial = 0; trial < 1500; trial++) {
      const enzymes = [...new Set(Array.from({ length: randInt(rand, 1, 3) }, () => pool[randInt(rand, 0, pool.length - 1)]))];
      const L = randInt(rand, 2, 80);
      const left = randomEnd(rand, Math.min(8, L - 1));
      const ends: FragmentEnds = { left, right: randomEnd(rand, Math.min(8, L - 1 - left.length)) };
      const from = ends.left.length; // first paired base
      const to = L - ends.right.length; // end of the paired bases
      let seq = randomDna(L, rand);
      for (let k = randInt(rand, 1, 4); k > 0; k--) {
        // sites straddling or near the single-stranded ends
        const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
        let text = instantiate(e.site, rand);
        if (rand() < 0.5) text = reverseComplement(text);
        if (text.length > L) continue;
        const anchor = rand() < 0.5 ? from : to;
        seq = plant(seq, Math.max(0, Math.min(L - text.length, anchor - randInt(rand, 0, text.length + 2))), text);
      }
      const sites = findSites(seq, 'linear', enzymes, { ends });
      // the same sites as without ends: only their cleavage events depend on the ends
      expect(sites.map((s) => [s.enzyme, s.range, s.strand])).toEqual(findSites(seq, 'linear', enzymes).map((s) => [s.enzyme, s.range, s.strand]));
      const report = digestDetailed(seq, 'linear', enzymes, { ends });
      const skippedAtEnd = report.skipped.filter((s) => s.reason === 'end');
      const endKeys = new Set(skippedAtEnd.map((s) => `${s.enzyme}@${s.site.start}/${s.strand}|${s.top},${s.bottom}`));
      let droppedHere = 0;
      for (const site of sites) {
        const canCut = (c: CutPair) =>
          Math.min(c.top, c.bottom) > from && Math.max(c.top, c.bottom) < to && site.range.start >= from && site.range.end <= to;
        const label = `${site.enzyme}@${site.range.start}/${site.strand} ${JSON.stringify(ends)} ${seq}`;
        const events = allEvents(site);
        expect([...site.cuts].sort(byCut), label).toEqual(events.filter(canCut).sort(byCut));
        // digest skips (reason 'end') exactly the events of this site that findSites drops
        for (const c of events) {
          expect(endKeys.has(`${site.enzyme}@${site.range.start}/${site.strand}|${c.top},${c.bottom}`), `${label} ${c.top},${c.bottom}`).toBe(!canCut(c));
        }
        kept += site.cuts.length;
        droppedHere += events.length - site.cuts.length;
      }
      expect(skippedAtEnd).toHaveLength(droppedHere);
      dropped += droppedHere;
    }
    console.info(`findSites with ends: ${kept} events kept, ${dropped} dropped at the ends (all as digest decides)`);
    expect(kept).toBeGreaterThan(1000);
    expect(dropped).toBeGreaterThan(1000);
  });
});

describe('review: circular cut positions are never negative zero', () => {
  it('reports the BaeI bottom cut -15 on a 15-bp circle as +0', () => {
    // BaeI (10/15)ACNNNNGTAYC(12/7) at 0: left event (-10, -15) -> (5, 0); right event (23, 18) -> (8, 3)
    const [site] = findSitesForEnzyme('ACAAAAGTATC' + 'TTTT', 'circular', E('BaeI'));
    expect(site.cuts.map((c) => [c.top, c.bottom])).toEqual([[5, 0], [8, 3]]);
    expect(Object.is(site.cuts[0].bottom, 0)).toBe(true);
  });

  it('never emits -0 or shared objects on small circles with far-reaching enzymes (digest neither)', () => {
    const rand = mulberry32(0x2e40);
    const enzymes = [
      ...['BaeI', 'CspCI', 'MmeI', 'BsaI', 'AbaSI', 'TspRI'].map(E),
      makeEnzyme({ name: 'Upstream', site: 'GAC', cuts: [{ top: -30, bottom: -27 }] }),
      makeEnzyme({ name: 'BothSides', site: 'CTTG', cuts: [{ top: 40, bottom: 36 }, { top: -8, bottom: -8 }] }),
    ];
    let negativeMultiples = 0;
    for (let trial = 0; trial < 400; trial++) {
      const L = randInt(rand, 1, 40);
      let seq = randomDna(L, rand);
      for (let k = randInt(rand, 1, 3); k > 0; k--) {
        const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
        let text = instantiate(e.site, rand);
        if (rand() < 0.5) text = reverseComplement(text);
        if (text.length <= L) seq = plant(seq, randInt(rand, 0, L - 1), text);
      }
      const sites = findSites(seq, 'circular', enzymes);
      expect(resultObjectProblems(sites), seq).toEqual([]);
      for (const site of sites) {
        const enzyme = enzymes.find((e) => e.name === site.enzyme) as RestrictionEnzyme;
        for (const c of allEvents(site, enzyme)) if ((c.top < 0 && c.top % L === 0) || (c.bottom < 0 && c.bottom % L === 0)) negativeMultiples++;
      }
      const report = digestDetailed(seq, 'circular', enzymes);
      expect(resultObjectProblems(report).filter((p) => p.endsWith('-0')), seq).toEqual([]);
    }
    expect(negativeMultiples).toBeGreaterThan(20); // the -0 case is exercised
  });
});
