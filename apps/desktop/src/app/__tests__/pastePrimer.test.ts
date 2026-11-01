import { describe, expect, it } from 'vitest';
import { parsePastedPrimer } from '../commands';

describe('parsePastedPrimer', () => {
  it('reads a bare sequence (any case, whitespace, line breaks)', () => {
    expect(parsePastedPrimer(' tag aag\nGCA CAG ')).toEqual({ sequence: 'TAGAAGGCACAG' });
  });
  it('reads FASTA with the name', () => {
    expect(parsePastedPrimer('>bGH-R\nTAGAAGGCACAGTCGAGGC\n')).toEqual({ name: 'bGH-R', sequence: 'TAGAAGGCACAGTCGAGGC' });
  });
  it('reads "name<tab>sequence" and "name sequence" lines', () => {
    expect(parsePastedPrimer('bGH-R\tTAGAAGGCACAGTCGAGGC')).toEqual({ name: 'bGH-R', sequence: 'TAGAAGGCACAGTCGAGGC' });
    expect(parsePastedPrimer('M13 fwd GTAAAACGACGGCCAGT')).toEqual({ name: 'M13 fwd', sequence: 'GTAAAACGACGGCCAGT' });
  });
  it('rejects text without a sequence', () => {
    expect(parsePastedPrimer('hello world')).toBeNull();
    expect(parsePastedPrimer('')).toBeNull();
  });
});
