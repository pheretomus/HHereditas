import type { Feature } from '@hhereditas/core';
import { reverseComplement } from '@hhereditas/core';
import { describe, expect, it } from 'vitest';
import { codonToAminoAcid, translateFeatureLite, translateLite } from './translate-lite';
import { buildCodingInfo, codonAtBase, codonRange, codonStartOffset, rowCodons } from './translation';

function cds(segments: Array<[number, number]>, strand: 1 | -1, qualifiers: Feature['qualifiers'] = []): Feature {
  return {
    id: 'cds',
    type: 'CDS',
    name: 'cds',
    strand,
    segments: segments.map(([start, end]) => ({ start, end })),
    qualifiers,
  };
}

describe('translate-lite', () => {
  it('translates with the standard genetic code', () => {
    expect(translateLite('ATGGCCAAATAA')).toBe('MAK*');
    expect(translateLite('TTTTTCTTATTGTGGTGATAGTAA')).toBe('FFLLW***');
    // a trailing partial codon is ignored
    expect(translateLite('ATGGC')).toBe('M');
    expect(translateLite('atgcgt')).toBe('MR');
  });

  it('resolves ambiguity codes when every codon they stand for agrees', () => {
    expect(codonToAminoAcid('GCN')).toBe('A');
    expect(codonToAminoAcid('TAR')).toBe('*');
    expect(codonToAminoAcid('NNN')).toBe('X');
    expect(codonToAminoAcid('ATN')).toBe('X'); // I or M
    expect(codonToAminoAcid('ATH')).toBe('I');
  });

  it('reads an alternative start codon as M only as the initiator', () => {
    expect(translateLite('GTGGTG', { table: 11, initiator: true })).toBe('MV');
    expect(translateLite('GTGGTG', { table: 11 })).toBe('VV');
    expect(translateLite('GTGGTG', { table: 1, initiator: true })).toBe('VV');
  });

  it('honours /transl_table, /codon_start and 5′-partial features', () => {
    const f = cds([[0, 6]], 1, [{ key: 'transl_table', value: '11' }]);
    expect(translateFeatureLite('GTGGTG', f)).toBe('MV');
    expect(translateFeatureLite('GTGGTG', { ...f, partialStart: true })).toBe('VV');
    expect(translateFeatureLite('GTGGTG', { ...f, qualifiers: [...f.qualifiers, { key: 'codon_start', value: '2' }] })).toBe('VV');
  });
});

describe('coding information', () => {
  //            0         1         2         3
  //            0123456789012345678901234567890123456789
  const seq = 'CCATGGCTAAATAGCCCCCCCCCCCCCCCCCCCCCCCCCC';

  it('maps the codons of a forward CDS', () => {
    const info = buildCodingInfo(cds([[2, 14]], 1), seq, 'linear', translateFeatureLite);
    expect(info.protein).toBe('MAK*');
    expect(info.codonCount).toBe(4);
    expect(codonAtBase(info, 2)).toBe(0);
    expect(codonAtBase(info, 7)).toBe(1);
    expect(codonAtBase(info, 13)).toBe(3);
    expect(codonAtBase(info, 1)).toBe(-1);
    expect(codonRange(info, 1, seq.length, 'linear')).toEqual({ start: 5, end: 8 });
  });

  it('maps the codons of a reverse CDS from its right end', () => {
    // the reverse complement of ATG GCT AAA TAG is CTA TTT AGC CAT
    const rev = 'GG' + reverseComplement('ATGGCTAAATAG') + 'GG';
    const info = buildCodingInfo(cds([[2, 14]], -1), rev, 'linear', translateFeatureLite);
    expect(info.protein).toBe('MAK*');
    expect(codonAtBase(info, 13)).toBe(0); // the start codon is at the right
    expect(codonAtBase(info, 2)).toBe(3);
    expect(codonRange(info, 0, rev.length, 'linear')).toEqual({ start: 11, end: 14 });
    expect(codonRange(info, 3, rev.length, 'linear')).toEqual({ start: 2, end: 5 });
  });

  it('skips the bases before /codon_start', () => {
    const f = cds([[1, 14]], 1, [{ key: 'codon_start', value: '2' }]);
    expect(codonStartOffset(f)).toBe(1);
    const info = buildCodingInfo(f, seq, 'linear', translateFeatureLite);
    expect(info.offset).toBe(1);
    expect(info.protein).toBe('MAK*');
    expect(codonAtBase(info, 1)).toBe(-1);
    expect(codonAtBase(info, 2)).toBe(0);
  });

  it('joins segments: a codon can span an intron', () => {
    // exon 1 = ATGG (2..6), intron 6..10, exon 2 = 8 bases from 10
    const s = 'CCATGGTTTTCTAAATAGCC';
    const info = buildCodingInfo(cds([[2, 6], [10, 18]], 1), s, 'linear', translateFeatureLite);
    expect(info.protein).toBe('MAK*'); // ATG GCT AAA TAG
    expect(codonAtBase(info, 5)).toBe(1); // G of GCT, in exon 1
    expect(codonAtBase(info, 7)).toBe(-1); // intron
    expect(codonAtBase(info, 10)).toBe(1); // C of GCT, in exon 2
    expect(codonRange(info, 1, s.length, 'linear')).toEqual({ start: 5, end: 12 });
  });

  it('follows a CDS across the origin of a circular record', () => {
    // CDS starts at 16 (ATG at the end) and continues at 0
    const s = 'GCTAAATAGCCCCCCCATG';
    const info = buildCodingInfo(cds([[16, 28]], 1), s, 'circular', translateFeatureLite);
    expect(info.protein).toBe('MAK*');
    expect(codonAtBase(info, 17)).toBe(0);
    expect(codonAtBase(info, 1)).toBe(1);
    expect(codonRange(info, 0, s.length, 'circular')).toEqual({ start: 16, end: 19 });
    expect(codonRange(info, 1, s.length, 'circular')).toEqual({ start: 0, end: 3 });
  });

  it('uses the fallback translator when the injected one throws', () => {
    const broken = () => {
      throw new Error('no');
    };
    const info = buildCodingInfo(cds([[2, 14]], 1), seq, 'linear', broken, translateFeatureLite);
    expect(info.protein).toBe('MAK*');
  });

  it('puts each amino acid under the middle base of its codon', () => {
    const info = buildCodingInfo(cds([[2, 14]], 1), seq, 'linear', translateFeatureLite);
    const { letters, shades } = rowCodons(info, 0, [{ startCol: 2, endCol: 14 }]);
    expect(letters.map((l) => [l.col, l.aa])).toEqual([
      [3, 'M'],
      [6, 'A'],
      [9, 'K'],
      [12, '*'],
    ]);
    expect(shades.map((s) => [s.c0, s.c1, s.codon])).toEqual([
      [2, 5, 0],
      [5, 8, 1],
      [8, 11, 2],
      [11, 14, 3],
    ]);
    // a row that starts in the middle of a codon gets the partial codon's shade, not its letter
    const row2 = rowCodons(info, 7, [{ startCol: 0, endCol: 7 }]);
    expect(row2.shades[0]).toEqual({ c0: 0, c1: 1, codon: 1 });
    expect(row2.letters.map((l) => l.aa)).toEqual(['K', '*']);
  });
});
