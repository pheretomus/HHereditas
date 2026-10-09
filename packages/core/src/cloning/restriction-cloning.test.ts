import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getEnzyme } from '../enzymes/enzyme';
import { findSitesForEnzyme } from '../enzymes/search';
import { parseGenbank } from '../io/genbank';
import { makeFeature, makeRecord } from '../seq/features';
import { restrictionClone } from './restriction-cloning';
import { canonicalCircular, randomDna, rng } from './test-helpers';

const FIX = join(__dirname, '../../test/fixtures/genbank');
const PUC19 = parseGenbank(readFileSync(join(FIX, 'pUC19_M77789.gb'), 'utf8')).records[0];
const L = PUC19.seq.length;
const topCut = (seq: string, e: string, topology: 'linear' | 'circular' = 'circular'): number[] =>
  findSitesForEnzyme(seq, topology, getEnzyme(e)!).flatMap((s) => s.cuts.map((c) => c.top));

describe('restrictionClone: EcoRI–BamHI insert into the pUC19 MCS (textbook)', () => {
  const rand = rng(11);
  const body = randomDna(rand, 600, ['GAATTC', 'GGATCC', 'AGATCT']);
  // In M77789 BamHI lies before EcoRI on the top strand, so the backbone runs EcoRI ... BamHI.
  const insertSeq = 'CGC' + 'GGATCC' + body + 'GAATTC' + 'GCG';
  const insert = makeRecord({
    name: 'ins',
    seq: insertSeq,
    features: [makeFeature({ type: 'CDS', name: 'gene', strand: 1, segments: [{ start: 50, end: 350 }] })],
  });
  const res = restrictionClone({ vector: PUC19, insert, vectorEnzymes: ['EcoRI', 'BamHI'] });

  it('gives one directional product of the expected sequence and length', () => {
    expect(res.error).toBeUndefined();
    expect(res.products).toHaveLength(1);
    const bam = topCut(PUC19.seq, 'BamHI')[0];
    const eco = topCut(PUC19.seq, 'EcoRI')[0];
    const iBam = topCut(insertSeq, 'BamHI', 'linear')[0];
    const iEco = topCut(insertSeq, 'EcoRI', 'linear')[0];
    const expected = PUC19.seq.slice(0, bam) + insertSeq.slice(iBam, iEco) + PUC19.seq.slice(eco);
    expect(res.product!.seq).toBe(expected); // numbered like the vector
    // product length = vector large fragment + insert (cut-to-cut sizes)
    const vecLarge = L - (eco - bam);
    expect(res.product!.seq.length).toBe(vecLarge + (iEco - iBam));
    expect(res.details[0].orientation).toBe('forward');
    expect(res.product!.topology).toBe('circular');
  });

  it('regenerates both sites, and the junctions report them', () => {
    const p = res.product!.seq;
    expect(topCut(p, 'EcoRI')).toHaveLength(1);
    expect(topCut(p, 'BamHI')).toHaveLength(1);
    const j = res.details[0].junctions;
    for (const x of j) expect(x.recutBy).toEqual(x.enzymes);
    expect(j.flatMap((x) => x.enzymes).sort()).toEqual(['BamHI', 'EcoRI']);
    for (const x of j) expect(p.slice(x.range.start, x.range.end)).toBe(x.overhang);
    expect(res.warnings.join(' ')).not.toMatch(/not recut|self-ligate|Non-directional/);
  });

  it('carries vector and insert features', () => {
    const gene = res.product!.features.find((f) => f.name === 'gene');
    expect(gene).toBeDefined();
    expect(res.product!.features.some((f) => f.name.startsWith('pBR322'))).toBe(true);
    expect(res.vectorFragment!.seq.length).toBe(L - (topCut(PUC19.seq, 'EcoRI')[0] - topCut(PUC19.seq, 'BamHI')[0]) + 4); // + right 5' overhang
    expect(res.insertFragment!.leftCut?.enzyme).toBe('BamHI');
  });

  it('an insert written in reverse is cloned in the right orientation (the reverse complement)', () => {
    const rc = makeRecord({ name: 'insRC', seq: canonicalFlip(insertSeq) });
    const r2 = restrictionClone({ vector: PUC19, insert: rc, vectorEnzymes: ['EcoRI', 'BamHI'] });
    expect(r2.products).toHaveLength(1);
    expect(r2.details[0].orientation).toBe('reverse');
    expect(r2.product!.seq).toBe(res.product!.seq);
    expect(restrictionClone({ vector: PUC19, insert: rc, vectorEnzymes: ['EcoRI', 'BamHI'], orientation: 'forward' }).error).toMatch(/only the reverse/);
  });
});

function canonicalFlip(s: string): string {
  const m: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
  return [...s].reverse().map((c) => m[c]).join('');
}

describe('restrictionClone: special cases', () => {
  const rand = rng(12);

  it('BamHI vector + BglII insert: hybrid sites not recut, non-directional and self-ligation warnings', () => {
    const body = randomDna(rand, 400, ['GGATCC', 'AGATCT']);
    const insert = makeRecord({ name: 'bgl', seq: 'AA' + 'AGATCT' + body + 'AGATCT' + 'AA' });
    const res = restrictionClone({ vector: PUC19, insert, vectorEnzymes: ['BamHI'], insertEnzymes: ['BglII'] });
    expect(res.products).toHaveLength(2);
    expect(res.details.map((d) => d.orientation)).toEqual(['forward', 'reverse']);
    const w = res.warnings.join('\n');
    expect(w).toMatch(/self-ligate/);
    expect(w).toMatch(/Non-directional/);
    expect(w).toMatch(/BamHI\/BglII junction .* hybrid site that is not recut/);
    for (const p of res.products) {
      expect(p.seq.length).toBe(L + 406); // vector + insert cut-to-cut (GATCT + body + A)
      expect(topCut(p.seq, 'BamHI')).toHaveLength(0);
      expect(topCut(p.seq, 'BglII')).toHaveLength(0);
      expect(p.seq).toContain('GGATCT');
    }
    expect(res.details[0].junctions.every((j) => j.recutBy.length === 0)).toBe(true);
  });

  it('reports a vector enzyme that does not cut, unknown enzymes and incompatible inserts', () => {
    const insert = makeRecord({ seq: 'AAGAATTC' + randomDna(rand, 100, ['GAATTC', 'GCGGCCGC', 'GGATCC']) + 'GAATTCAA' });
    expect(restrictionClone({ vector: PUC19, insert, vectorEnzymes: ['NotI'] }).error).toMatch(/NotI does not cut the vector/);
    expect(restrictionClone({ vector: PUC19, insert, vectorEnzymes: ['FooI'] }).error).toMatch(/Unknown enzyme 'FooI'/);
    const r = restrictionClone({ vector: PUC19, insert, vectorEnzymes: ['BamHI'], insertEnzymes: ['EcoRI'] });
    expect(r.error).toMatch(/No insert fragment has ends compatible/);
    expect(r.vectorFragment).toBeDefined();
  });

  it('warns about internal sites that fragment the insert', () => {
    const b = randomDna(rand, 150, ['GAATTC']);
    const insert = makeRecord({ seq: 'AAGAATTC' + b + 'GAATTC' + b + 'GAATTCAA' });
    const res = restrictionClone({ vector: PUC19, insert, vectorEnzymes: ['EcoRI'] });
    expect(res.warnings.join(' ')).toMatch(/cut 3 times/);
    expect(res.products.length).toBeGreaterThan(0);
  });

  it('blunt cloning (SmaI): self-ligation warning, both orientations', () => {
    const insert = makeRecord({ seq: randomDna(rand, 300, ['CCCGGG']) });
    // a linear blunt PCR product used whole: cut with an enzyme absent from the insert -> uncut linear fragment
    const res = restrictionClone({ vector: PUC19, insert, vectorEnzymes: ['SmaI'], insertEnzymes: ['SmaI'] });
    expect(res.products).toHaveLength(2);
    expect(res.products[0].seq.length).toBe(L + 300);
    expect(res.warnings.join(' ')).toMatch(/self-ligate/);
    expect(canonicalCircular(res.products[0].seq)).not.toBe(canonicalCircular(res.products[1].seq));
  });
});
