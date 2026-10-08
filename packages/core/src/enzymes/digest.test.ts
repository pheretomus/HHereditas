import { describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  genbankSequence,
  instantiate,
  mulberry32,
  plant,
  randInt,
  randomDna,
  resultObjectProblems,
  rotate,
} from '../../test/oracle/enzymes/load';
import type { DnaEnd, FragmentEnds, Topology } from '../types';
import { iupacMatches, reverseComplement } from '../seq/alphabet';
import { sliceRange } from '../seq/range';
import { COMMERCIAL_ENZYMES, COMMON_ENZYMES, ENZYMES, getEnzyme, makeEnzyme } from './enzyme';
import type { RestrictionEnzyme } from './enzyme';
import { digest, digestDetailed, digestSizes } from './digest';
import type { DigestCut, DigestFragment, DigestReport, SkippedCleavage } from './digest';
import { findSites } from './search';

function E(name: string): RestrictionEnzyme {
  const e = getEnzyme(name);
  if (e === undefined) throw new Error(`missing enzyme ${name}`);
  return e;
}

const blunt: DnaEnd = { kind: 'blunt', length: 0 };
const five = (length: number): DnaEnd => ({ kind: '5prime', length });
const three = (length: number): DnaEnd => ({ kind: '3prime', length });
const PUC19 = genbankSequence(`${FIXTURES_DIR}/genbank/pUC19_M77789.gb`);

/** Compact view of fragments for readable expectations. */
const view = (frags: DigestFragment[]) => frags.map((f) => [f.seq, f.ends.left, f.ends.right]);

describe('digest: hand-checked examples', () => {
  it('cuts a linear molecule with EcoRI (5prime overhangs)', () => {
    const frags = digest('AAGAATTCAAGAATTCAA', 'linear', [E('EcoRI')]);
    expect(view(frags)).toEqual([
      ['AAGAATT', blunt, five(4)],
      ['AATTCAAGAATT', five(4), five(4)],
      ['AATTCAA', five(4), blunt],
    ]);
    expect(frags.map((f) => f.parentRange)).toEqual([
      { start: 0, end: 7 },
      { start: 3, end: 15 },
      { start: 11, end: 18 },
    ]);
    expect(frags[0].leftCut).toBeUndefined();
    expect(frags[0].rightCut).toEqual({ enzyme: 'EcoRI', top: 3, bottom: 7 });
    expect(frags[1].leftCut).toEqual({ enzyme: 'EcoRI', top: 3, bottom: 7 });
    expect(frags[2].rightCut).toBeUndefined();
    expect(frags.every((f) => f.topology === 'linear' && f.length === f.seq.length)).toBe(true);
  });

  it('linearizes a circle cut once, keeping both overhangs (origin-spanning site)', () => {
    const [frag, ...rest] = digest('TTCAAGAA', 'circular', [E('EcoRI')]);
    expect(rest).toEqual([]);
    expect(frag).toEqual({
      seq: 'AATTCAAGAATT',
      topology: 'linear',
      ends: { left: five(4), right: five(4) },
      parentRange: { start: 6, end: 18 },
      length: 12,
      leftCut: { enzyme: 'EcoRI', top: 6, bottom: 2 },
      rightCut: { enzyme: 'EcoRI', top: 6, bottom: 2 },
    });
    expect(sliceRange('TTCAAGAA', frag.parentRange)).toBe(frag.seq);
  });

  it('produces PstI 3prime overhangs', () => {
    expect(view(digest('AAACTGCAGAAA', 'linear', [E('PstI')]))).toEqual([
      ['AAACTGCA', blunt, three(4)],
      ['TGCAGAAA', three(4), blunt],
    ]);
    // KpnI GGTAC^C, SacI GAGCT^C, ApaI GGGCC^C
    expect(view(digest('AAGGTACCAA', 'linear', [E('KpnI')]))).toEqual([
      ['AAGGTAC', blunt, three(4)],
      ['GTACCAA', three(4), blunt],
    ]);
  });

  it('produces SmaI blunt ends and XmaI 5prime ends on the same site', () => {
    expect(view(digest('AAACCCGGGAAA', 'linear', [E('SmaI')]))).toEqual([
      ['AAACCC', blunt, blunt],
      ['GGGAAA', blunt, blunt],
    ]);
    expect(view(digest('AAACCCGGGAAA', 'linear', [E('XmaI')]))).toEqual([
      ['AAACCCGG', blunt, five(4)],
      ['CCGGGAAA', five(4), blunt],
    ]);
  });

  it('excises a Golden Gate part between inward-facing BsaI sites', () => {
    const insert = 'CATCGATCGATTTACG';
    const vector = 'TTTTTTTTTT' + 'GGTCTCA' + 'AATG' + insert + 'GCTT' + 'TGAGACC' + 'TTTTTTTTTT';
    const frags = digest(vector, 'linear', [E('BsaI')]);
    expect(frags).toHaveLength(3);
    expect(view([frags[1]])).toEqual([['AATG' + insert + 'GCTT', five(4), five(4)]]);
    expect(frags[1].leftCut).toEqual({ enzyme: 'BsaI', top: 17, bottom: 21 });
    // circular vector (58 bp): backbone [37, 79) = 42 bases and the 24-base part, sharing 4-nt overhangs
    expect(digestSizes(vector, 'circular', [E('BsaI')])).toEqual([42, 24]);
  });

  it('excises the BaeI site with two double-strand breaks (3prime overhangs)', () => {
    const seq = 'T'.repeat(20) + 'ACAAAAGTATC' + 'T'.repeat(20);
    const frags = digest(seq, 'linear', [E('BaeI')]);
    // events (10, 5) and (43, 38): middle fragment spans [5, 43)
    expect(view(frags)).toEqual([
      ['T'.repeat(10), blunt, three(5)],
      [seq.slice(5, 43), three(5), three(5)],
      [seq.slice(38), three(5), blunt],
    ]);
  });

  it('digests pUC19 with EcoRI + HindIII (polylinker fragment)', () => {
    const frags = digest(PUC19, 'circular', [E('EcoRI'), E('HindIII')]);
    expect(frags.map((f) => [f.parentRange, f.length, f.leftCut?.enzyme, f.rightCut?.enzyme])).toEqual([
      [{ start: 233, end: 288 }, 55, 'HindIII', 'EcoRI'],
      [{ start: 284, end: 2923 }, 2639, 'EcoRI', 'HindIII'],
    ]);
    expect(frags[0].seq.startsWith('AGCTTGCATGC')).toBe(true);
    expect(frags[0].seq.endsWith('GAGCTCGAATT')).toBe(true); // SacI site, then G^AATT
    expect(frags[0].ends).toEqual({ left: five(4), right: five(4) });
    expect(digestSizes(PUC19, 'circular', [E('EcoRI'), E('HindIII')])).toEqual([2639, 55]);
    expect(digestSizes(PUC19, 'circular', [E('EcoRI')])).toEqual([2690]);
  });

  it('returns the intact molecule when nothing cuts', () => {
    expect(digest('ACGTACGT', 'circular', [E('EcoRI')])).toEqual([
      { seq: 'ACGTACGT', topology: 'circular', ends: { left: blunt, right: blunt }, parentRange: { start: 0, end: 8 }, length: 8 },
    ]);
    expect(digest('ACGTACGT', 'linear', [])).toEqual([
      { seq: 'ACGTACGT', topology: 'linear', ends: { left: blunt, right: blunt }, parentRange: { start: 0, end: 8 }, length: 8 },
    ]);
    const ends: FragmentEnds = { left: five(2), right: three(3) };
    expect(digest('ACGTACGT', 'linear', [E('EcoRI')], { ends })[0].ends).toEqual(ends);
  });

  it('returns no fragment for an empty sequence', () => {
    expect(digest('', 'linear', ENZYMES)).toEqual([]);
    expect(digest('', 'circular', [E('EcoRI')])).toEqual([]);
    expect(digestSizes('', 'linear', [E('EcoRI')])).toEqual([]);
    expect(digest('G', 'linear', [E('EcoRI')])).toHaveLength(1);
  });

  it('keeps the case of the input', () => {
    expect(digest('aagaattcaa', 'linear', [E('EcoRI')]).map((f) => f.seq)).toEqual(['aagaatt', 'aattcaa']);
  });

  it('does not mutate its inputs', () => {
    const enzymes = [E('EcoRI')];
    const ends: FragmentEnds = { left: five(1), right: blunt };
    digest('AAGAATTCAA', 'linear', enzymes, { ends });
    expect(enzymes).toEqual([E('EcoRI')]);
    expect(ends).toEqual({ left: five(1), right: blunt });
  });
});

describe('digest: linear ends', () => {
  it('outer fragments keep sticky input ends', () => {
    // an EcoRI fragment (5' AATT overhangs) cut again with BamHI
    const seq = 'AATTCAAAGGATCCAAAG';
    const ends: FragmentEnds = { left: five(4), right: five(4) };
    expect(view(digest(seq, 'linear', [E('BamHI')], { ends }))).toEqual([
      ['AATTCAAAGGATC', five(4), five(4)],
      ['GATCCAAAG', five(4), five(4)],
    ]);
  });

  it('skips cleavage inside a single-stranded end', () => {
    // left 5' overhang of 6 covers the MboI site GATC at 1..4
    const report = digestDetailed('AGATCAAAAAAAAAAAAA', 'linear', [E('MboI')], { ends: { left: five(6), right: blunt } });
    expect(report.fragments).toHaveLength(1);
    expect(report.skipped).toMatchObject([{ enzyme: 'MboI', reason: 'end', top: 1, bottom: 5 }]);
    // with a blunt end the same site cleaves (cuts at 1 and 5 lie inside [1, L - 1])
    expect(digest('AGATCAAAAAAAAAAAAA', 'linear', [E('MboI')])).toHaveLength(2);
  });

  it('reports events whose cuts fall at or beyond the ends (Biopython rule)', () => {
    const report = digestDetailed('GATCAAAAAAGGTCTCAA', 'linear', [E('MboI'), E('BsaI')]);
    expect(report.fragments).toHaveLength(1);
    expect(report.skipped.map((s) => [s.enzyme, s.reason, s.top, s.bottom])).toEqual([
      ['MboI', 'end', 0, 4],
      ['BsaI', 'end', 17, 21],
    ]);
  });

  it('validates the input ends', () => {
    expect(() => digest('ACGT', 'linear', [], { ends: { left: five(3), right: five(2) } })).toThrow(/longer than the molecule/);
    expect(() => digest('ACGT', 'linear', [], { ends: { left: { kind: 'blunt', length: 2 }, right: blunt } })).toThrow(/blunt/);
    expect(() => digest('ACGT', 'linear', [], { ends: { left: five(-1), right: blunt } })).toThrow(/length/);
    // ends are ignored for circular molecules
    expect(digest('ACGT', 'circular', [], { ends: { left: five(9), right: blunt } })).toHaveLength(1);
  });
});

describe('digest: conflicting cleavage events', () => {
  const flank = 'T'.repeat(10);

  it('applies the first of two BsaI events whose cut zones touch, never making unpaired fragments', () => {
    // GGTCTC at 10 cuts (17, 21); GAGACC at 18 cuts (13, 17): zones [13,17) and [17,21) touch
    const seq = flank + 'GGTCTCAAGAGACC' + flank;
    const report = digestDetailed(seq, 'linear', [E('BsaI')]);
    expect(report.fragments.map((f) => f.parentRange)).toEqual([
      { start: 0, end: 17 },
      { start: 13, end: 34 },
    ]);
    expect(report.skipped).toEqual([
      {
        enzyme: 'BsaI',
        site: { start: 10, end: 16 },
        strand: 1,
        top: 17,
        bottom: 21,
        reason: 'conflict',
        message: expect.stringContaining('cannot cut') as unknown as string,
        blockedBy: { enzyme: 'BsaI', top: 13, bottom: 17 },
      },
    ]);
  });

  it('resolves overlapping zones and blunt cuts inside another overhang', () => {
    // GAGACC at 20 cuts (15, 19); GGTCTC at 10 cuts (17, 21): overlapping zones
    const overlap = digestDetailed(flank + 'GGTCTCAAAAGAGACC' + flank, 'linear', [E('BsaI')]);
    expect(overlap.fragments).toHaveLength(2);
    expect(overlap.skipped.map((s) => [s.top, s.bottom, s.blockedBy])).toEqual([[17, 21, { enzyme: 'BsaI', top: 15, bottom: 19 }]]);
    // HindIII A^AGCTT contains AluI AG^CT: the blunt AluI cut would fall inside the HindIII overhang
    const nested = digestDetailed('CCCCAAGCTTCCCC', 'linear', [E('AluI'), E('HindIII')]);
    expect(view(nested.fragments)).toEqual([
      ['CCCCAAGCT', blunt, five(4)],
      ['AGCTTCCCC', five(4), blunt],
    ]);
    expect(nested.skipped.map((s) => [s.enzyme, s.reason])).toEqual([['AluI', 'conflict']]);
  });

  it('applies identical double-strand breaks once', () => {
    // BamHI G^GATCC and MboI ^GATC make the same break
    const report = digestDetailed('AAAGGATCCAAA', 'linear', [E('MboI'), E('BamHI')]);
    expect(report.fragments).toHaveLength(2);
    expect(report.fragments[0].rightCut).toEqual({ enzyme: 'BamHI', top: 4, bottom: 8 });
    expect(report.skipped).toEqual([]);
  });

  it('resolves conflicts on circles independently of the origin', () => {
    const core = 'GGTCTCAAGAGACC' + 'ACGTTGCAAGCTAGCATCGATCGGATCCATG';
    const reference = digestDetailed(core, 'circular', [E('BsaI'), E('BamHI')]);
    expect(reference.skipped).toHaveLength(1);
    const canonical = (r: DigestReport) => r.fragments.map((f) => `${f.seq}|${f.ends.left.kind}${f.ends.left.length}|${f.ends.right.kind}${f.ends.right.length}`).sort();
    for (let k = 0; k < core.length; k++) {
      const rotated = digestDetailed(rotate(core, k), 'circular', [E('BsaI'), E('BamHI')]);
      expect(canonical(rotated), `rotation ${k}`).toEqual(canonical(reference));
      expect(rotated.skipped).toHaveLength(1);
    }
  });

  it('still produces paired fragments when conflicting cut zones cover the whole circle', () => {
    // every A of an all-A circle is a site of this enzyme: zones [p, p + 3] cover the circle
    const wide = makeEnzyme({ name: 'Wide', site: 'A', cuts: [{ top: 0, bottom: 3 }] });
    const report = digestDetailed('AAAAAAAA', 'circular', [wide]);
    // no free starting point: the walk starts at the smallest rotation (here the origin), keeping (0, 3) and (4, 7)
    expect(report.fragments.map((f) => [f.parentRange, f.ends.left, f.ends.right])).toEqual([
      [{ start: 0, end: 7 }, five(3), five(3)],
      [{ start: 4, end: 11 }, five(3), five(3)],
    ]);
    expect(report.skipped).toHaveLength(6);
    checkInvariants('AAAAAAAA', 'circular', [wide], report);
  });

  it('skips an event whose overhang is as long as a tiny circle', () => {
    // TspRI CASTG(2/-7): 9-nt 3' overhang on a 9-bp circle
    const report = digestDetailed('CACTGAAAA', 'circular', [E('TspRI')]);
    expect(report.fragments).toEqual([
      { seq: 'CACTGAAAA', topology: 'circular', ends: { left: blunt, right: blunt }, parentRange: { start: 0, end: 9 }, length: 9 },
    ]);
    expect(report.skipped.map((s) => s.reason)).toEqual(['overhang-too-long']);
    expect(digest('CACTGAAAAA', 'circular', [E('TspRI')])[0].length).toBe(19);
  });
});

/** Check every structural invariant of a digest report against its parent molecule. */
function checkInvariants(seq: string, topology: Topology, enzymes: RestrictionEnzyme[], report: DigestReport, ends?: FragmentEnds): void {
  const L = seq.length;
  const frags = report.fragments;
  const applied = frags.map((f) => f.rightCut).filter((c) => c !== undefined);
  if (topology === 'circular' && frags.length === 1 && frags[0].topology === 'circular') {
    expect(frags[0].seq).toBe(seq);
    expect(applied).toEqual([]);
  } else {
    expect(frags.every((f) => f.topology === 'linear')).toBe(true);
    expect(frags.length).toBe(topology === 'circular' ? applied.length : applied.length + 1);
  }
  let covered = 0;
  for (let i = 0; i < frags.length; i++) {
    const f = frags[i];
    expect(f.length).toBe(f.seq.length);
    expect(sliceRange(seq, f.parentRange)).toBe(f.seq);
    // at least one base pair between the single-stranded ends: no unpaired or negative fragments
    expect(f.length - f.ends.left.length - f.ends.right.length).toBeGreaterThanOrEqual(1);
    if (i > 0) expect(f.parentRange.start).toBeGreaterThanOrEqual(frags[i - 1].parentRange.start);
    const next = frags[i + 1] ?? (topology === 'circular' ? frags[0] : undefined);
    if (next !== undefined && f.topology === 'linear') {
      expect(next.leftCut).toEqual(f.rightCut);
      expect(next.ends.left).toEqual(f.ends.right);
      const k = f.ends.right.length;
      expect(f.seq.slice(f.seq.length - k)).toBe(next.seq.slice(0, k)); // ligatable sticky ends
    }
    covered += f.length - (i === 0 && topology === 'linear' ? 0 : f.ends.left.length);
  }
  if (frags.length > 0 && frags[0].topology === 'linear') expect(covered).toBe(L);
  if (topology === 'linear' && frags.length > 0) {
    expect(frags[0].ends.left).toEqual(ends?.left ?? blunt);
    expect(frags[frags.length - 1].ends.right).toEqual(ends?.right ?? blunt);
    // stitching the fragments over their shared overhangs restores the parent
    let joined = frags[0].seq;
    for (let i = 1; i < frags.length; i++) joined += frags[i].seq.slice(frags[i].ends.left.length);
    expect(joined).toBe(seq);
  }
  // every cleavage event of the site search is applied or reported (identical breaks merged);
  // with blunt ends, events skipped at the ends are exactly those findSites already omits
  const key = (c: { top: number; bottom: number }) => `${c.top},${c.bottom}`;
  const found = new Set(findSites(seq, topology, enzymes).flatMap((s) => s.cuts.map(key)));
  const appliedKeys = new Set(applied.map(key));
  const skippedKeys = new Set(report.skipped.map(key));
  for (const k of found) expect(appliedKeys.has(k) || skippedKeys.has(k), k).toBe(true);
  for (const k of appliedKeys) expect(found.has(k), k).toBe(true);
  const bluntEnds = ends === undefined || (ends.left.length === 0 && ends.right.length === 0);
  for (const s of report.skipped) {
    if (s.reason !== 'end' || bluntEnds) expect(found.has(key(s)), `${s.reason} ${key(s)}`).toBe(s.reason !== 'end');
    if (s.reason === 'conflict') expect(appliedKeys.has(key(s.blockedBy as { top: number; bottom: number }))).toBe(true);
  }
}

describe('digest: properties on seeded random input', () => {
  const rand = mulberry32(0xd16e57);
  const pool = ['EcoRI', 'BamHI', 'PstI', 'SmaI', 'BsaI', 'BsmBI', 'SapI', 'BaeI', 'CspCI', 'BglI', 'AvaI', 'MmeI', 'MlyI', 'HinfI', 'TspRI', 'SgeI', 'MboI', 'AluI', 'DpnI', 'NlaIII'].map(E);

  function randomCase(): { seq: string; enzymes: RestrictionEnzyme[] } {
    const enzymes = Array.from({ length: randInt(rand, 1, 3) }, () => pool[randInt(rand, 0, pool.length - 1)]);
    const L = randInt(rand, 1, 250);
    let seq = randomDna(L, rand);
    for (let k = randInt(rand, 0, 5); k > 0; k--) {
      const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
      let text = instantiate(e.site, rand);
      if (rand() < 0.5) text = reverseComplement(text);
      if (text.length <= L) seq = plant(seq, randInt(rand, 0, L - 1), text);
    }
    return { seq, enzymes };
  }

  it('fragments always tile the parent with ligatable ends', () => {
    let conflicts = 0;
    for (let trial = 0; trial < 600; trial++) {
      const { seq, enzymes } = randomCase();
      for (const topology of ['linear', 'circular'] as const) {
        const report = digestDetailed(seq, topology, enzymes);
        checkInvariants(seq, topology, enzymes, report);
        conflicts += report.skipped.filter((s) => s.reason === 'conflict').length;
      }
      const n = seq.length;
      if (n >= 4) {
        const left = rand() < 0.5 ? five(randInt(rand, 0, 2)) : three(randInt(rand, 0, 2));
        const ends: FragmentEnds = { left: left.length === 0 ? blunt : left, right: rand() < 0.5 ? blunt : five(1) };
        checkInvariants(seq, 'linear', enzymes, digestDetailed(seq, 'linear', enzymes, { ends }), ends);
      }
    }
    expect(conflicts).toBeGreaterThan(50); // the conflict-resolution path is exercised
  });

  it('circular results do not depend on the origin', () => {
    for (let trial = 0; trial < 150; trial++) {
      const { seq, enzymes } = randomCase();
      const canonical = (frags: DigestFragment[]) => frags.map((f) => `${f.seq}|${f.ends.left.kind}${f.ends.left.length}|${f.ends.right.kind}${f.ends.right.length}`).sort();
      const reference = canonical(digest(seq, 'circular', enzymes));
      const k = randInt(rand, 0, seq.length - 1);
      const rotated = digest(rotate(seq, k), 'circular', enzymes);
      if (rotated.length === 1 && rotated[0].topology === 'circular') expect(digest(seq, 'circular', enzymes)[0].topology).toBe('circular');
      else expect(canonical(rotated), `${seq} k=${k}`).toEqual(reference);
    }
  });

  it('is symmetric under reverse complement when no event conflicts', () => {
    for (let trial = 0; trial < 200; trial++) {
      const { seq, enzymes } = randomCase();
      const forward = digestDetailed(seq, 'linear', enzymes);
      if (forward.skipped.some((s) => s.reason === 'conflict')) continue;
      const backward = digest(reverseComplement(seq), 'linear', enzymes);
      const mirrored = [...forward.fragments].reverse().map((f) => [reverseComplement(f.seq), f.ends.right, f.ends.left]);
      expect(view(backward)).toEqual(mirrored);
    }
  });

  it('digestSizes lists fragment lengths, largest first', () => {
    for (let trial = 0; trial < 50; trial++) {
      const { seq, enzymes } = randomCase();
      const lengths = digest(seq, 'circular', enzymes).map((f) => f.length);
      expect(digestSizes(seq, 'circular', enzymes)).toEqual(lengths.sort((a, b) => b - a));
    }
  });
});

// ---------------------------------------------------------------------------
// Regression tests for defects found by adversarial review
// ---------------------------------------------------------------------------

describe('regression: identical breaks are validated per recognition site before merging (sticky input ends)', () => {
  it('keeps the EcoRI cut when a BsmBI site making the same AATT break runs into the sticky end', () => {
    // EcoRI GAATTC at [10,16): break (11,15). BsmBI reverse site GAGACG at [16,22): break (16+6-11, 16+6-7) = (11,15).
    // Right 5' overhang of 6: bases [18,24) exist only on the bottom strand, so the BsmBI site is not fully double-stranded.
    const seq = 'ACGTACGTAC' + 'GAATTC' + 'GAGACG' + 'TT';
    const ends: FragmentEnds = { left: blunt, right: five(6) };
    expect(digest(seq, 'linear', [E('EcoRI')], { ends })).toHaveLength(2);
    for (const enzymes of [[E('BsmBI'), E('EcoRI')], [E('EcoRI'), E('BsmBI')]]) {
      const r = digestDetailed(seq, 'linear', enzymes, { ends });
      expect(view(r.fragments)).toEqual([
        ['ACGTACGTACGAATT', blunt, five(4)],
        ['AATTCGAGACGTT', five(4), five(6)],
      ]);
      expect(r.fragments[0].rightCut).toEqual({ enzyme: 'EcoRI', top: 11, bottom: 15 });
      // the BsmBI site that cannot cut is reported with its own footprint
      expect(r.skipped.map((s) => [s.enzyme, s.reason, s.site, s.strand, s.top, s.bottom])).toEqual([
        ['BsmBI', 'end', { start: 16, end: 22 }, -1, 11, 15],
      ]);
      checkInvariants(seq, 'linear', enzymes, r, ends);
    }
  });

  it('MlyI: the fully double-stranded twin site cuts although the other twin straddles the overhang', () => {
    // MlyI GAGTC(5/5) blunt: forward site [0,5) -> cut 10; reverse site GACTC at [15,20) -> cut 15+5-10 = 10.
    const seq = 'GAGTC' + 'A'.repeat(10) + 'GACTC' + 'A'.repeat(10);
    expect(digest(seq, 'linear', [E('MlyI')])).toHaveLength(2);
    const ends: FragmentEnds = { left: five(1), right: blunt };
    const r = digestDetailed(seq, 'linear', [E('MlyI')], { ends });
    expect(r.fragments.map((f) => f.parentRange)).toEqual([{ start: 0, end: 10 }, { start: 10, end: 30 }]);
    expect(r.skipped.map((s) => [s.enzyme, s.reason, s.site, s.strand])).toEqual([['MlyI', 'end', { start: 0, end: 5 }, 1]]);
    // same with the forward twin at 1 straddling a 2-nt overhang (both make the blunt break at 11)
    const seq2 = 'A' + 'GAGTC' + 'A'.repeat(10) + 'GACTC' + 'A'.repeat(9);
    const r2 = digestDetailed(seq2, 'linear', [E('MlyI')], { ends: { left: five(2), right: blunt } });
    expect(r2.fragments.map((f) => f.parentRange)).toEqual([{ start: 0, end: 11 }, { start: 11, end: 30 }]);
    expect(r2.skipped.map((s) => [s.enzyme, s.reason, s.site])).toEqual([['MlyI', 'end', { start: 1, end: 6 }]]);
  });

  it('adding BsaI does not remove the cut that BsmAI makes alone (pydna 5.5.16 also cuts)', () => {
    // BsaI GGTCTC at [0,6) (base 0 single-stranded) and BsmAI GTCTC at [1,6) both make break (7, 11).
    // pydna: Dseq.from_full_sequence_and_overhangs('GGTCTC'+'A'*24, -1, 0).get_cutsites(BsaI, BsmAI) -> [((7, -4), BsmAI)]
    const seq = 'GGTCTC' + 'A'.repeat(24);
    const ends: FragmentEnds = { left: five(1), right: blunt };
    const alone = digest(seq, 'linear', [E('BsmAI')], { ends });
    expect(alone.map((f) => f.parentRange)).toEqual([{ start: 0, end: 11 }, { start: 7, end: 30 }]);
    const both = digestDetailed(seq, 'linear', [E('BsaI'), E('BsmAI')], { ends });
    expect(view(both.fragments)).toEqual(view(alone));
    expect(both.fragments[0].rightCut).toEqual({ enzyme: 'BsmAI', top: 7, bottom: 11 });
    expect(both.skipped.map((s) => [s.enzyme, s.reason, s.site])).toEqual([['BsaI', 'end', { start: 0, end: 6 }]]);
  });
});

describe('regression: conflicts between identical cut zones are resolved by enzyme name, as documented', () => {
  it('applies ApaI rather than PspOMI on GGGCCC (same zone, opposite overhangs), whatever the input order', () => {
    // ApaI GGGCC^C -> (top 8, bottom 4), 3' overhang; PspOMI G^GGCCC -> (top 4, bottom 8), 5' overhang.
    for (const enzymes of [[E('ApaI'), E('PspOMI')], [E('PspOMI'), E('ApaI')]]) {
      const r = digestDetailed('AAAGGGCCCAAA', 'linear', enzymes);
      expect(view(r.fragments)).toEqual([
        ['AAAGGGCC', blunt, three(4)],
        ['GGCCCAAA', three(4), blunt],
      ]);
      expect(r.fragments[0].rightCut?.enzyme).toBe('ApaI');
      expect(r.skipped.map((s) => [s.enzyme, s.reason, s.blockedBy])).toEqual([['PspOMI', 'conflict', { enzyme: 'ApaI', top: 8, bottom: 4 }]]);
    }
  });

  it('applies ApaI on a circle and on the reverse-complemented molecule too', () => {
    const circle = 'AAAGGGCCCAAATTTTTTTTTT';
    for (const seq of [circle, reverseComplement(circle), rotate(circle, 7)]) {
      const r = digestDetailed(seq, 'circular', [E('ApaI'), E('PspOMI')]);
      expect(r.fragments).toHaveLength(1);
      expect(r.fragments[0].leftCut?.enzyme).toBe('ApaI');
      expect(r.fragments[0].ends).toEqual({ left: three(4), right: three(4) });
      expect(r.skipped.map((s) => [s.enzyme, s.reason])).toEqual([['PspOMI', 'conflict']]);
    }
  });
});

describe('regression: conflict resolution does not depend on the strand the molecule is written on', () => {
  const RC19 = reverseComplement(PUC19);

  it('pUC19 + BsaJI (two overlapping CCNNGG sites at the SmaI site of the MCS)', () => {
    expect(digestSizes(RC19, 'circular', [E('BsaJI')])).toEqual(digestSizes(PUC19, 'circular', [E('BsaJI')]));
    expectMirrored(PUC19, 'circular', [E('BsaJI')]);
  });

  it('pUC19 + AccII + BsmBI (BsmBI cut zone overlapping two AccII blunt cuts)', () => {
    expect(digestSizes(RC19, 'circular', [E('AccII'), E('BsmBI')])).toEqual(digestSizes(PUC19, 'circular', [E('AccII'), E('BsmBI')]));
    expectMirrored(PUC19, 'circular', [E('AccII'), E('BsmBI')]);
    expectMirrored(PUC19, 'linear', [E('AccII'), E('BsmBI')]);
  });

  it('palindromic molecule with different sticky ends: the ends decide the walking strand', () => {
    // seq equals its reverse complement; the facing BsaI sites (cuts (17,21) and (13,17), touching
    // zones) form a conflict group centred on the middle of the molecule, so only the ends differ
    const seq = 'T'.repeat(10) + 'GGTCTCATGAGACC' + 'A'.repeat(10);
    expect(reverseComplement(seq)).toBe(seq);
    for (const ends of [
      { left: five(2), right: blunt },
      { left: blunt, right: three(3) },
      { left: five(2), right: three(2) },
    ]) {
      expectMirrored(seq, 'linear', [E('BsaI')], ends);
      expect(digestDetailed(seq, 'linear', [E('BsaI')], { ends }).skipped.map((s) => s.reason)).toEqual(['conflict']);
    }
    // symmetric ends: the molecule is its own mirror image, so the two possible choices are mirror
    // images of each other (one 4-nt 5' overhang break in the middle, 2 fragments either way)
    const report = digestDetailed(seq, 'linear', [E('BsaI')], { ends: { left: five(2), right: five(2) } });
    expect(report.skipped.map((s) => s.reason)).toEqual(['conflict']);
    expect(report.fragments.map((f) => [f.ends.left, f.ends.right])).toEqual([[five(2), five(4)], [five(4), five(2)]]);
    expect(report.fragments.map((f) => f.length).sort((a, b) => a - b)).toEqual([17, 21]);
  });

  it('pUC19: every pair of a common and a commercial enzyme gives the same fragment sizes on both strands', () => {
    // before the fix, 1,134 of these pairs gave different sizes (review scan); about 1 s
    const differing: string[] = [];
    for (const a of COMMON_ENZYMES) {
      for (const b of COMMERCIAL_ENZYMES) {
        const forward = digestSizes(PUC19, 'circular', [a, b]);
        const backward = digestSizes(RC19, 'circular', [a, b]);
        if (forward.join() !== backward.join()) differing.push(`${a.name}+${b.name}`);
      }
    }
    expect(differing).toEqual([]);
  });

  it('pUC19 and pBR322: every commercial enzyme alone gives mirror-image digests (linear and circular)', () => {
    const PBR322 = genbankSequence(`${FIXTURES_DIR}/genbank/pBR322_J01749.gb`);
    for (const plasmid of [PUC19, PBR322]) {
      for (const e of COMMERCIAL_ENZYMES) {
        expectMirrored(plasmid, 'circular', [e]);
        expectMirrored(plasmid, 'linear', [e]);
      }
    }
  });
});

describe('regression: input ends must leave at least one base pair', () => {
  it('rejects ends whose lengths add up to the molecule length', () => {
    // left 3' 4 + right 5' 4 on an 8-mer: the top strand would be empty
    for (const ends of [
      { left: three(4), right: five(4) },
      { left: five(4), right: three(4) },
      { left: five(4), right: five(4) },
      { left: three(4), right: three(4) },
      { left: five(8), right: blunt },
      { left: blunt, right: three(8) },
    ]) {
      expect(() => digest('AAAATTTT', 'linear', [E('EcoRI')], { ends }), JSON.stringify(ends)).toThrow(/no base pair/);
    }
    expect(() => digest('A', 'linear', [], { ends: { left: five(1), right: blunt } })).toThrow(/no base pair/);
  });

  it('accepts ends that leave exactly one base pair', () => {
    const ends: FragmentEnds = { left: five(3), right: five(4) };
    const [frag, ...rest] = digest('AAAATTTT', 'linear', [E('EcoRI')], { ends });
    expect(rest).toEqual([]);
    expect(frag.length - frag.ends.left.length - frag.ends.right.length).toBe(1);
  });
});

/** Mirror a cut onto the reverse-complemented molecule of length L (gap g -> L - g). */
function mirrorCut(c: { enzyme: string; top: number; bottom: number }, L: number, circular: boolean) {
  const top = L - c.bottom;
  const bottom = L - c.top;
  return { enzyme: c.enzyme, top: circular ? ((top % L) + L) % L : top, bottom: circular ? ((bottom % L) + L) % L : bottom };
}

/** Skipped events as comparable strings (messages excluded). */
function skippedSignature(skipped: SkippedCleavage[]): string[] {
  return skipped.map((s) => JSON.stringify([s.enzyme, s.reason, s.site, s.strand, s.top, s.bottom, s.blockedBy])).sort();
}

/** A report of `seq` rewritten in the coordinates of reverseComplement(seq) (messages excluded). */
function mirrorReport(report: DigestReport, L: number, topology: Topology, enzymes: readonly RestrictionEnzyme[]) {
  const circular = topology === 'circular';
  const palindromic = new Map(enzymes.map((e) => [e.name, reverseComplement(e.site) === e.site]));
  const mirrorRange = (r: { start: number; end: number }) => {
    const start = circular ? (((L - r.end) % L) + L) % L : L - r.end;
    return { start, end: start + (r.end - r.start) };
  };
  const fragments = [...report.fragments].reverse().map((f) => ({
    seq: reverseComplement(f.seq),
    topology: f.topology,
    ends: { left: f.ends.right, right: f.ends.left },
    parentRange: mirrorRange(f.parentRange),
    length: f.length,
    ...(f.rightCut !== undefined ? { leftCut: mirrorCut(f.rightCut, L, circular) } : {}),
    ...(f.leftCut !== undefined ? { rightCut: mirrorCut(f.leftCut, L, circular) } : {}),
  }));
  const skipped: SkippedCleavage[] = report.skipped.map((s) => {
    const cut = mirrorCut(s, L, circular);
    return {
      ...s,
      site: mirrorRange(s.site),
      strand: palindromic.get(s.enzyme) ? 1 : s.strand === 1 ? -1 : 1,
      top: cut.top,
      bottom: cut.bottom,
      ...(s.blockedBy !== undefined ? { blockedBy: mirrorCut(s.blockedBy, L, circular) } : {}),
    };
  });
  return { fragments, skipped: skippedSignature(skipped) };
}

const byParentRange = (frags: DigestFragment[]) =>
  [...frags].sort((a, b) => a.parentRange.start - b.parentRange.start || a.parentRange.end - b.parentRange.end);

/** digestDetailed(reverseComplement(seq)) must be the exact mirror image of digestDetailed(seq). */
function expectMirrored(seq: string, topology: Topology, enzymes: RestrictionEnzyme[], ends?: FragmentEnds): void {
  const L = seq.length;
  const forward = digestDetailed(seq, topology, enzymes, ends ? { ends } : undefined);
  const mirrorEnds = ends ? { ends: { left: ends.right, right: ends.left } } : undefined;
  const backward = digestDetailed(reverseComplement(seq), topology, enzymes, mirrorEnds);
  const expected = mirrorReport(forward, L, topology, enzymes);
  const label = `${enzymes.map((e) => e.name).join('+')} ${topology} ${JSON.stringify(ends)} ${seq}`;
  expect(byParentRange(backward.fragments), label).toEqual(byParentRange(expected.fragments));
  expect(skippedSignature(backward.skipped), label).toEqual(expected.skipped);
}

// ---------------------------------------------------------------------------
// Independent first-principles model and symmetry properties (guards for the fixes above)
// ---------------------------------------------------------------------------

interface ReferenceCut {
  enzyme: string;
  top: number;
  bottom: number;
}

/**
 * First-principles model of a LINEAR digest, written independently of digest.ts and search.ts:
 * every start position is tested base by base on both strands. A cleavage event can cut when
 * (a) both products keep at least one base pair, i.e. min(top, bottom) > first paired gap and
 * max(top, bottom) < last paired gap, and (b) its own recognition site is fully double-stranded.
 * Identical breaks are made once (reported enzyme: smallest name among the sites that can cut).
 * Returns undefined when two breaks that can be made leave no base pair between their cut zones
 * (conflicts are not modelled here). `shadowed` counts breaks made by one site although another
 * site making the same break cannot cut.
 */
function referenceLinearDigest(seq: string, enzymes: readonly RestrictionEnzyme[], ends: FragmentEnds) {
  const L = seq.length;
  const target = seq.toUpperCase();
  const single = (end: DnaEnd, kind: DnaEnd['kind']) => (end.kind === kind ? end.length : 0);
  // the top strand covers [topFrom, topTo), the bottom strand [bottomFrom, bottomTo)
  const topFrom = single(ends.left, '3prime');
  const bottomFrom = single(ends.left, '5prime');
  const topTo = L - single(ends.right, '5prime');
  const bottomTo = L - single(ends.right, '3prime');
  const pairedFrom = Math.max(topFrom, bottomFrom);
  const pairedTo = Math.min(topTo, bottomTo);
  const canCut = new Map<string, ReferenceCut>();
  const cannotCut = new Set<string>();
  for (const enzyme of enzymes) {
    const site = enzyme.site;
    const n = site.length;
    const palindromic = reverseComplement(site) === site;
    for (let p = 0; p + n <= L; p++) {
      for (const strand of palindromic ? [1] : [1, -1]) {
        const pattern = strand === 1 ? site : reverseComplement(site);
        let match = true;
        for (let j = 0; j < n && match; j++) match = 'ACGT'.includes(target[p + j]) && iupacMatches(pattern[j], target[p + j]);
        if (!match) continue;
        for (const c of enzyme.cuts) {
          const events: Array<{ top: number; bottom: number }> = [];
          if (strand === 1) events.push({ top: p + c.top, bottom: p + c.bottom });
          if (strand === -1 || palindromic) events.push({ top: p + n - c.bottom, bottom: p + n - c.top });
          for (const ev of events) {
            const key = `${ev.top},${ev.bottom}`;
            const productsPaired = Math.min(ev.top, ev.bottom) > pairedFrom && Math.max(ev.top, ev.bottom) < pairedTo;
            const siteDouble = p >= pairedFrom && p + n <= pairedTo;
            if (!productsPaired || !siteDouble) {
              cannotCut.add(key);
              continue;
            }
            const known = canCut.get(key);
            if (known === undefined || enzyme.name < known.enzyme) canCut.set(key, { enzyme: enzyme.name, ...ev });
          }
        }
      }
    }
  }
  const lo = (c: { top: number; bottom: number }) => Math.min(c.top, c.bottom);
  const hi = (c: { top: number; bottom: number }) => Math.max(c.top, c.bottom);
  const breaks = [...canCut.values()].sort((a, b) => lo(a) - lo(b));
  for (let i = 1; i < breaks.length; i++) if (lo(breaks[i]) <= hi(breaks[i - 1])) return undefined;
  const bounds: Array<{ top: number; bottom: number; cut?: ReferenceCut }> = [
    { top: topFrom, bottom: bottomFrom },
    ...breaks.map((b) => ({ top: b.top, bottom: b.bottom, cut: b })),
    { top: topTo, bottom: bottomTo },
  ];
  const endOf = (b: { top: number; bottom: number }): DnaEnd => (b.top === b.bottom ? blunt : b.top < b.bottom ? five(b.bottom - b.top) : three(b.top - b.bottom));
  const fragments = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    fragments.push({ seq: seq.slice(lo(a), hi(b)), ends: { left: endOf(a), right: endOf(b) }, leftCut: a.cut, rightCut: b.cut });
  }
  return { fragments, shadowed: [...canCut.keys()].filter((k) => cannotCut.has(k)).length };
}

/** Random valid ends for a linear molecule of length L (each overhang up to `max` bases, at least 1 bp left). */
function randomEnds(rand: () => number, L: number, max: number): FragmentEnds {
  const end = (room: number): DnaEnd => {
    const kind = (['blunt', '5prime', '3prime'] as const)[randInt(rand, 0, 2)];
    return kind === 'blunt' || room < 1 ? blunt : { kind, length: randInt(rand, 1, room) };
  };
  const left = end(Math.min(max, L - 1));
  return { left, right: end(Math.min(max, L - 1 - left.length)) };
}

const reachOf = (e: RestrictionEnzyme) => e.site.length + Math.max(...e.cuts.flatMap((c) => [Math.abs(c.top), Math.abs(c.bottom)]));

describe('digest: independent first-principles model of sticky-ended linear digests', () => {
  it('agrees with the model on random molecules with sites planted at both ends (coinciding breaks included)', () => {
    const rand = mulberry32(0x5717c4);
    // Type IIS enzymes whose sites contain each other's (BsaI/BsmBI ⊃ BsmAI, MlyI = PleI site,
    // BspQI ⊃ SapI/EarI, BamHI ⊃ MboI/DpnI/AlwI) so that different sites make identical breaks
    const pool = ['BsaI', 'BsmAI', 'BsmBI', 'Esp3I', 'EcoRI', 'MlyI', 'PleI', 'BaeI', 'CspCI', 'SapI', 'BspQI', 'EarI', 'BbsI', 'BsmFI',
      'FokI', 'HgaI', 'MboI', 'BamHI', 'DpnI', 'AlwI', 'MmeI', 'AcuI', 'BtgZI', 'HinfI', 'PstI', 'KpnI'].map(E);
    // outer site contains the inner site one base from its 5' end; both make the same break
    const nested = [['BsaI', 'BsmAI'], ['BsmBI', 'BsmAI'], ['Esp3I', 'BsmAI'], ['SapI', 'EarI'], ['BspQI', 'EarI']].map((pair) => pair.map(E));
    let compared = 0;
    let conflicts = 0;
    let shadowed = 0;
    for (let trial = 0; trial < 4000; trial++) {
      const picks = Array.from({ length: randInt(rand, 1, 3) }, () => pool[randInt(rand, 0, pool.length - 1)]);
      const L = randInt(rand, 12, 90);
      let ends = randomEnds(rand, L, 10);
      let seq = randomDna(L, rand);
      if (trial % 2 === 0) {
        // the outer site straddles a single-stranded end, the inner one is fully double-stranded
        const [outer, inner] = nested[randInt(rand, 0, nested.length - 1)];
        picks.push(outer, inner);
        const n = outer.site.length;
        const sticky = (): DnaEnd => (rand() < 0.5 ? five(randInt(rand, 1, 6)) : three(randInt(rand, 1, 6)));
        if (rand() < 0.5) {
          ends = { left: sticky(), right: ends.right.length + 7 < L ? ends.right : blunt };
          seq = plant(seq, ends.left.length - 1, instantiate(outer.site, rand));
        } else {
          ends = { left: ends.left.length + 7 < L ? ends.left : blunt, right: sticky() };
          seq = plant(seq, L - ends.right.length - n + 1, reverseComplement(instantiate(outer.site, rand)));
        }
      }
      const enzymes = [...new Map(picks.map((e) => [e.name, e])).values()];
      const pairedFrom = ends.left.length;
      const pairedTo = L - ends.right.length;
      for (let k = randInt(rand, 1, 4); k > 0; k--) {
        const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
        let text = instantiate(e.site, rand);
        if (rand() < 0.5) text = reverseComplement(text);
        const n = text.length;
        if (n > L) continue;
        const r = Math.min(reachOf(e), L - n);
        const u = rand();
        let pos: number;
        if (u < 0.2) pos = pairedFrom - randInt(rand, 0, n); // straddles the left single-stranded end
        else if (u < 0.4) pos = pairedTo - n + randInt(rand, 0, n); // straddles the right one
        else if (u < 0.6) pos = randInt(rand, 0, r);
        else if (u < 0.8) pos = randInt(rand, L - n - r, L - n);
        else pos = randInt(rand, 0, L - n);
        seq = plant(seq, Math.max(0, Math.min(L - n, pos)), text);
      }
      const reference = referenceLinearDigest(seq, enzymes, ends);
      const report = digestDetailed(seq, 'linear', enzymes, { ends });
      if (reference === undefined) {
        conflicts++;
        continue;
      }
      const label = `${enzymes.map((e) => e.name).join('+')} ${JSON.stringify(ends)} ${seq}`;
      expect(report.fragments.map((f) => ({ seq: f.seq, ends: f.ends, leftCut: f.leftCut, rightCut: f.rightCut })), label).toEqual(reference.fragments);
      expect(report.skipped.filter((s) => s.reason !== 'end'), label).toEqual([]);
      checkInvariants(seq, 'linear', enzymes, report, ends);
      compared++;
      shadowed += reference.shadowed;
    }
    console.info(`first-principles model: ${compared} sticky-ended digests identical (${shadowed} breaks shadowed by a site that cannot cut), ${conflicts} with conflicts not modelled`);
    expect(compared).toBeGreaterThan(3000);
    expect(shadowed).toBeGreaterThan(20);
  });
});

/** True when the molecule is its own mirror image (reverse complement; circles: up to rotation; linear: ends included). */
function isSelfMirror(seq: string, topology: Topology, ends?: FragmentEnds): boolean {
  const up = seq.toUpperCase();
  const rc = reverseComplement(up);
  if (topology === 'circular') return (up + up).includes(rc);
  const left = ends?.left ?? blunt;
  const right = ends?.right ?? blunt;
  return up === rc && left.kind === right.kind && left.length === right.length;
}

/** True when a circular sequence equals one of its non-trivial rotations. */
function isPeriodic(seq: string): boolean {
  const up = seq.toUpperCase();
  return (up + up).indexOf(up, 1) < up.length;
}

/** Orientation- and origin-free description of a report: fragments up to reverse complement (circles up to rotation too). */
function physicalSignature(report: DigestReport): { fragments: string[]; skipped: string[] } {
  const linearKey = (seq: string, ends: FragmentEnds) => `${seq.toUpperCase()}|${ends.left.kind}${ends.left.length}|${ends.right.kind}${ends.right.length}`;
  const fragments = report.fragments.map((f) => {
    if (f.topology === 'circular') {
      const rotations = [f.seq, reverseComplement(f.seq)].flatMap((s) => [...s].map((_, k) => rotate(s.toUpperCase(), k)));
      return `circular|${rotations.sort()[0]}`;
    }
    const a = linearKey(f.seq, f.ends);
    const b = linearKey(reverseComplement(f.seq), { left: f.ends.right, right: f.ends.left });
    return `linear|${a < b ? a : b}`;
  });
  return { fragments: fragments.sort(), skipped: report.skipped.map((s) => `${s.enzyme}|${s.reason}`).sort() };
}

/** Rewrites a report of rotate(seq, k) in the coordinates of seq (positions + k modulo L), messages excluded. */
function unrotateReport(report: DigestReport, L: number, k: number) {
  const shift = (p: number) => (((p + k) % L) + L) % L;
  const range = (r: { start: number; end: number }) => ({ start: shift(r.start), end: shift(r.start) + (r.end - r.start) });
  const cut = (c: DigestCut) => ({ enzyme: c.enzyme, top: shift(c.top), bottom: shift(c.bottom) });
  const fragments = report.fragments.map((f) => ({
    ...f,
    parentRange: f.topology === 'circular' ? f.parentRange : range(f.parentRange),
    ...(f.leftCut !== undefined ? { leftCut: cut(f.leftCut) } : {}),
    ...(f.rightCut !== undefined ? { rightCut: cut(f.rightCut) } : {}),
  }));
  const skipped = report.skipped.map((s) => ({
    ...s,
    site: range(s.site),
    top: shift(s.top),
    bottom: shift(s.bottom),
    ...(s.blockedBy !== undefined ? { blockedBy: cut(s.blockedBy) } : {}),
  }));
  return { fragments: byParentRange(fragments), skipped: skippedSignature(skipped) };
}

describe('digest: conflict resolution depends on neither strand, origin nor enzyme order', () => {
  // user-defined enzymes whose cut zones overlap at almost every position of A/T-rich or GC-rich DNA
  const wide = [
    makeEnzyme({ name: 'WideA', site: 'A', cuts: [{ top: 0, bottom: 3 }] }),
    makeEnzyme({ name: 'WideW', site: 'W', cuts: [{ top: 0, bottom: 3 }] }),
    makeEnzyme({ name: 'WideSN', site: 'SN', cuts: [{ top: 4, bottom: 1 }] }),
  ];
  const pool = [
    ...['BsaJI', 'AccII', 'BsmBI', 'BsaI', 'BsmAI', 'HhaI', 'ApaI', 'PspOMI', 'AluI', 'HindIII', 'KpnI', 'Acc65I', 'SmaI', 'XmaI', 'MlyI',
      'PleI', 'BaeI', 'CspCI', 'SgeI', 'MspJI', 'BglI', 'AvaI', 'TspRI', 'HaeIII', 'CviKI-1', 'FokI', 'MboI', 'BamHI', 'NlaIII', 'FatI'].map(E),
    ...wide,
  ];

  function randomCase(rand: () => number): { seq: string; enzymes: RestrictionEnzyme[] } {
    const picks = Array.from({ length: randInt(rand, 1, 3) }, () => pool[randInt(rand, 0, pool.length - 1)]);
    const enzymes = [...new Map(picks.map((e) => [e.name, e])).values()];
    const L = randInt(rand, 1, 140);
    const u = rand();
    let seq = randomDna(L, rand, u < 0.3 ? 'GGCCA' : u < 0.4 ? 'AAT' : 'ACGT');
    for (let k = randInt(rand, 0, 5); k > 0; k--) {
      const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
      let text = instantiate(e.site, rand);
      if (rand() < 0.5) text = reverseComplement(text);
      if (text.length <= L) seq = plant(seq, randInt(rand, 0, L - 1), text);
    }
    return { seq, enzymes };
  }

  it('writing the molecule as its reverse complement mirrors the digest exactly (conflicts and sticky ends included)', () => {
    const rand = mulberry32(0x5eed42);
    let conflicts = 0;
    let exact = 0;
    for (let trial = 0; trial < 1500; trial++) {
      const { seq, enzymes } = randomCase(rand);
      for (const topology of ['linear', 'circular'] as const) {
        const ends = topology === 'linear' && seq.length > 1 && rand() < 0.5 ? randomEnds(rand, seq.length, 8) : undefined;
        const report = digestDetailed(seq, topology, enzymes, ends ? { ends } : undefined);
        checkInvariants(seq, topology, enzymes, report, ends);
        conflicts += report.skipped.filter((s) => s.reason === 'conflict').length;
        if (isSelfMirror(seq, topology, ends)) {
          const mirrorEnds = ends ? { ends: { left: ends.right, right: ends.left } } : undefined;
          expect(physicalSignature(digestDetailed(reverseComplement(seq), topology, enzymes, mirrorEnds))).toEqual(physicalSignature(report));
        } else {
          expectMirrored(seq, topology, enzymes, ends);
          exact++;
        }
      }
    }
    console.info(`reverse-complement symmetry: ${exact} exact mirror images, ${conflicts} conflicts resolved`);
    expect(conflicts).toBeGreaterThan(1000);
  });

  it('moving the origin of a circle rotates the digest exactly', () => {
    const rand = mulberry32(0x0219e5);
    let conflicts = 0;
    for (let trial = 0; trial < 1500; trial++) {
      const { seq, enzymes } = randomCase(rand);
      const L = seq.length;
      if (L < 2) continue;
      const k = randInt(rand, 1, L - 1);
      const report = digestDetailed(seq, 'circular', enzymes);
      const rotated = digestDetailed(rotate(seq, k), 'circular', enzymes);
      conflicts += report.skipped.filter((s) => s.reason === 'conflict').length;
      if (isPeriodic(seq)) {
        expect(physicalSignature(rotated)).toEqual(physicalSignature(report));
        continue;
      }
      const expected = { fragments: byParentRange(report.fragments), skipped: skippedSignature(report.skipped) };
      const actual = unrotateReport(rotated, L, k);
      if (report.fragments[0]?.topology === 'circular') {
        expect(rotated.fragments.map((f) => f.topology)).toEqual(['circular']);
        expect(actual.skipped).toEqual(expected.skipped);
      } else {
        expect(actual, `${enzymes.map((e) => e.name).join('+')} k=${k} ${seq}`).toEqual(expected);
      }
    }
    expect(conflicts).toBeGreaterThan(1000);
  });

  it('resolves cut zones covering the whole circle independently of origin and strand', () => {
    // On A/T-only DNA every base is a WideA site (forward A: zone [p, p+3]; reverse T: zone [p-2, p+1]),
    // so the zones cover the circle and no point is free to start the walk.
    const rand = mulberry32(0xc1c1e);
    let checked = 0;
    for (let trial = 0; trial < 400; trial++) {
      const L = randInt(rand, 6, 60);
      const seq = randomDna(L, rand, 'AT');
      if (isPeriodic(seq)) continue;
      const enzymes = rand() < 0.5 ? [wide[0]] : [wide[0], wide[1]];
      const report = digestDetailed(seq, 'circular', enzymes);
      checkInvariants(seq, 'circular', enzymes, report);
      expect(report.fragments.length).toBeGreaterThan(0);
      const k = randInt(rand, 1, L - 1);
      expect(unrotateReport(digestDetailed(rotate(seq, k), 'circular', enzymes), L, k), `k=${k} ${seq}`).toEqual({
        fragments: byParentRange(report.fragments),
        skipped: skippedSignature(report.skipped),
      });
      if (!isSelfMirror(seq, 'circular')) expectMirrored(seq, 'circular', enzymes);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('does not depend on the order of the enzymes', () => {
    const rand = mulberry32(0x0bde7);
    for (let trial = 0; trial < 600; trial++) {
      const { seq, enzymes } = randomCase(rand);
      const reordered = [...enzymes].reverse();
      for (const topology of ['linear', 'circular'] as const) {
        expect(digestDetailed(seq, topology, reordered)).toEqual(digestDetailed(seq, topology, enzymes));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Regression tests for defects found by adversarial review (shared objects, gel sizes)
// ---------------------------------------------------------------------------

describe('review: digest results are fresh objects that callers may modify', () => {
  it('gives an uncut circle its own, unfrozen blunt ends', () => {
    const [uncut] = digest('ACGTACGT', 'circular', [E('EcoRI')]);
    expect(uncut.topology).toBe('circular');
    expect(uncut.ends.left).not.toBe(uncut.ends.right);
    expect([Object.isFrozen(uncut.ends), Object.isFrozen(uncut.ends.left), Object.isFrozen(uncut.ends.right)]).toEqual([false, false, false]);
    uncut.ends.left.length = 0; // threw a TypeError when the frozen module constant was returned
    uncut.ends.right.kind = '5prime';
    expect(uncut.ends.left).toEqual(blunt);
    expect(digest('ACGTACGT', 'circular', [E('EcoRI')])[0].ends).toEqual({ left: blunt, right: blunt });
  });

  it('does not share DigestCut objects between neighbouring fragments or the two ends of a linearized circle', () => {
    const frags = digest('AAGAATTCAAGAATTCAA', 'linear', [E('EcoRI')]);
    expect(frags[0].rightCut).toEqual(frags[1].leftCut);
    expect(frags[0].rightCut).not.toBe(frags[1].leftCut);
    frags[1].leftCut!.top -= 3;
    expect(frags[0].rightCut).toEqual({ enzyme: 'EcoRI', top: 3, bottom: 7 });
    const [once] = digest('TTCAAGAA', 'circular', [E('EcoRI')]);
    expect(once.leftCut).toEqual(once.rightCut);
    expect(once.leftCut).not.toBe(once.rightCut);
  });

  it('gives every skipped event its own blockedBy object', () => {
    // AluI AG^CT and CviKI-1 RG^CY make the same blunt break inside the HindIII overhang: both are blocked by HindIII
    const report = digestDetailed('CCCCAAGCTTCCCC', 'linear', [E('AluI'), E('CviKI-1'), E('HindIII')]);
    const blocked = report.skipped.filter((s) => s.reason === 'conflict');
    expect(blocked.map((s) => [s.enzyme, s.blockedBy])).toEqual([
      ['AluI', { enzyme: 'HindIII', top: 5, bottom: 9 }],
      ['CviKI-1', { enzyme: 'HindIII', top: 5, bottom: 9 }],
    ]);
    expect(blocked[0].blockedBy).not.toBe(blocked[1].blockedBy);
    expect(blocked[0].blockedBy).not.toBe(report.fragments[0].rightCut);
  });

  it('never returns shared, frozen or input objects, nor -0 (random digests)', () => {
    const rand = mulberry32(0xf7e54);
    const pool = ['EcoRI', 'BamHI', 'MboI', 'BstYI', 'AluI', 'CviKI-1', 'HindIII', 'BsaI', 'BsmAI', 'BsmBI', 'PstI', 'SmaI', 'XmaI', 'BaeI',
      'CspCI', 'MlyI', 'PleI', 'TspRI', 'SgeI', 'NlaIII', 'HaeIII', 'NotI'].map(E);
    const seen = { uncut: 0, linearizedCircles: 0, sharedBreaks: 0, conflicts: 0 };
    for (let trial = 0; trial < 800; trial++) {
      const enzymes = [...new Set(Array.from({ length: randInt(rand, 1, 3) }, () => pool[randInt(rand, 0, pool.length - 1)]))];
      const L = randInt(rand, 1, 120);
      let seq = randomDna(L, rand);
      for (let k = randInt(rand, 0, 4); k > 0; k--) {
        const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
        let text = instantiate(e.site, rand);
        if (rand() < 0.5) text = reverseComplement(text);
        if (text.length <= L) seq = plant(seq, randInt(rand, 0, L - 1), text);
      }
      for (const topology of ['linear', 'circular'] as const) {
        const ends = topology === 'linear' && L > 1 && rand() < 0.5 ? randomEnds(rand, L, 6) : undefined;
        const report = digestDetailed(seq, topology, enzymes, ends ? { ends } : undefined);
        const inputs: object[] = [enzymes, ...enzymes, ...(ends ? [ends, ends.left, ends.right] : [])];
        expect(resultObjectProblems(report, inputs), `${enzymes.map((e) => e.name).join('+')} ${topology} ${seq}`).toEqual([]);
        expect(resultObjectProblems(digest(seq, topology, enzymes, ends ? { ends } : undefined), inputs)).toEqual([]);
        const frags = report.fragments;
        if (frags.length === 1 && frags[0].topology === 'circular') seen.uncut++;
        if (topology === 'circular' && frags.length === 1 && frags[0].leftCut !== undefined) seen.linearizedCircles++;
        if (frags.length > 1 && frags.some((f) => f.leftCut !== undefined && f.rightCut !== undefined)) seen.sharedBreaks++;
        seen.conflicts += report.skipped.filter((s) => s.reason === 'conflict').length;
      }
    }
    console.info(`fresh-object check: ${JSON.stringify(seen)}`);
    expect(Math.min(seen.uncut, seen.linearizedCircles, seen.sharedBreaks, seen.conflicts)).toBeGreaterThan(20);
  });
});

describe('review: digestSizes for gel lanes (reviewer reproduction)', () => {
  it('digestSizes distinguishes an uncut plasmid from a linear molecule', () => {
    const plasmid = 'GAATTC' + 'ACGT'.repeat(500);
    expect(digestSizes(plasmid, 'circular', [E('NotI')])).not.toEqual(digestSizes(plasmid, 'linear', []));
  });
});
