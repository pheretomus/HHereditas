/**
 * Unit tests of the SnapGene reader: behaviour on the real fixture files, on the handmade
 * edge-case files (test/oracle/snapgene/cases) and on small files built in memory.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featureSequence } from '../seq/features';
import { reverseComplement } from '../seq/alphabet';
import { translateFeature } from '../seq/translate';
import type { Feature, SeqRecord } from '../types';
import type { ParseResult } from './types';
import { encodeUtf8 } from './snapgene-binary';
import { isSnapGeneFile, parseSnapGene } from './snapgene';
import { FIXTURE_DIR, ORACLE_DIR, PMD19_LACZ, PMD20_LACZ, libraryExcerptFile, recordProblems } from '../../test/oracle/snapgene/testkit';

const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
const caseFile = (name: string) => new Uint8Array(readFileSync(join(ORACLE_DIR, 'cases', `${name}.dna`)));

function readOne(data: Uint8Array, fileName?: string): { record: SeqRecord; warnings: string[] } {
  const result = parseSnapGene(data, fileName === undefined ? {} : { fileName });
  expect(result.records).toHaveLength(1);
  expect(recordProblems(result.records[0])).toEqual([]);
  return { record: result.records[0], warnings: result.warnings.map((w) => w.message) };
}

function noRecord(result: ParseResult): string[] {
  expect(result.records).toHaveLength(0);
  expect(result.warnings.length).toBeGreaterThan(0);
  return result.warnings.map((w) => w.message);
}

const feature = (record: SeqRecord, name: string) => {
  const f = record.features.find((x) => x.name === name);
  if (f === undefined) throw new Error(`no feature ${name}`);
  return f;
};

// --- building small files in memory ---------------------------------------------------------

function bytes(...parts: Array<string | number[] | Uint8Array>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? encodeUtf8(p) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function packet(type: number, payload: string | number[] | Uint8Array): Uint8Array {
  const body = bytes(payload);
  const n = body.length;
  return bytes([type, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], body);
}

const cookie = (sequenceType = 1) => packet(0x09, bytes('SnapGene', [0, sequenceType, 0, 15, 0, 19]));
const dna = (seq: string, flags = 0x02) => packet(0x00, bytes([flags], seq));
const features = (xml: string) => packet(0x0a, `<?xml version="1.0"?><Features>${xml}</Features>`);
const notes = (xml: string) => packet(0x06, `<Notes>${xml}</Notes>`);
const file = (...packets: Uint8Array[]) => bytes(...packets);

describe('isSnapGeneFile', () => {
  it('recognises SnapGene files by their cookie packet', () => {
    for (const name of ['pFA-KanMX4.dna', 'sample-d.dna', 'looped_feature.dna']) expect(isSnapGeneFile(fixture(name))).toBe(true);
    expect(isSnapGeneFile(caseFile('protein_file'))).toBe(true);
    expect(isSnapGeneFile(caseFile('rna_file'))).toBe(true);
    expect(isSnapGeneFile(fixture('pFA-KanMX4.dna').subarray(0, 13))).toBe(true);
  });

  it('rejects other data', () => {
    const genbank = new Uint8Array(readFileSync(join(FIXTURE_DIR, '..', 'genbank', 'pUC19_M77789.gb')));
    expect(isSnapGeneFile(genbank)).toBe(false);
    expect(isSnapGeneFile(new Uint8Array(0))).toBe(false);
    expect(isSnapGeneFile(fixture('sample-d.dna').subarray(0, 12))).toBe(false);
    expect(isSnapGeneFile(bytes([0x0a, 0, 0, 0, 14], 'SnapGene', [0, 1, 0, 15, 0, 19]))).toBe(false);
    expect(isSnapGeneFile(bytes([0x09, 0, 0, 0, 14], 'SnapGenX', [0, 1, 0, 15, 0, 19]))).toBe(false);
  });

  it('reports non-SnapGene data with a warning and no record', () => {
    expect(noRecord(parseSnapGene(encodeUtf8('LOCUS  x 10 bp DNA\n')))).toEqual(['Not a SnapGene file: it does not start with the "SnapGene" cookie packet.']);
    noRecord(parseSnapGene(new Uint8Array(0)));
  });
});

describe('sequence packet', () => {
  it('reads topology and the strandedness/methylation flags', () => {
    for (let flags = 0; flags < 32; flags++) {
      const { record } = readOne(file(cookie(), dna('ACGT', flags)));
      expect(record.topology).toBe(flags & 1 ? 'circular' : 'linear');
      expect(record.meta.extras).toEqual({
        Strandedness: flags & 2 ? 'double' : 'single',
        DamMethylated: flags & 4 ? '1' : '0',
        DcmMethylated: flags & 8 ? '1' : '0',
        EcoKIMethylated: flags & 16 ? '1' : '0',
      });
    }
  });

  it('builds a minimal record', () => {
    const { record, warnings } = readOne(file(cookie(), dna('acgtn', 0x03)));
    expect(warnings).toEqual([]);
    expect(record).toMatchObject({ name: 'Untitled', description: '', seq: 'ACGTN', topology: 'circular', molecule: 'DNA', features: [], primers: [] });
    expect(record.ends).toBeUndefined();
    expect(record.meta.sourceFormat).toBe('snapgene');
    expect(record.id).toMatch(/^doc_/);
  });

  it('upper-cases, converts U to T and replaces other characters by N without changing the length', () => {
    const { record, warnings } = readOne(caseFile('sequence_chars'));
    expect(record.seq).toBe('ACGTRYSWKMBDHVNTTNNNNNNNACGT');
    expect(record.seq.length).toBe('acgtRYSWKMBDHVNuU-*. X\x00Zacgt'.length);
    expect(warnings.join('\n')).toMatch(/7 character\(s\) that are not IUPAC.*'N'/);
    const nonAscii = readOne(caseFile('sequence_non_ascii'));
    expect(nonAscii.record.seq).toBe('ACGTNNNACGT');
    expect(nonAscii.warnings.join('\n')).toContain('0xff');
  });

  it('names the record after the file', () => {
    const data = file(cookie(), dna('A'));
    const name = (fileName?: string) => parseSnapGene(data, fileName === undefined ? {} : { fileName }).records[0].name;
    expect(name('pUC19.dna')).toBe('pUC19');
    expect(name('C:\\Users\\lab\\pUC19 v2.dna')).toBe('pUC19 v2');
    expect(name('/data/my.plasmid.dna')).toBe('my.plasmid');
    expect(name('noext')).toBe('noext');
    expect(name('.dna')).toBe('.dna');
    expect(name('folder/')).toBe('Untitled');
    expect(name('')).toBe('Untitled');
    expect(name()).toBe('Untitled');
  });

  it('accepts an empty sequence with a warning', () => {
    const { record, warnings } = readOne(caseFile('empty_sequence'));
    expect(record.seq).toBe('');
    expect(warnings).toContain('The SnapGene file contains an empty DNA sequence.');
  });

  it('refuses files without a readable DNA packet', () => {
    expect(noRecord(parseSnapGene(caseFile('no_dna_packet')))).toContain('The SnapGene file contains no DNA sequence packet.');
    expect(noRecord(parseSnapGene(caseFile('protein_file')))).toContain('This is a SnapGene protein file (.prot); only SnapGene DNA files (.dna) can be read.');
    expect(noRecord(parseSnapGene(caseFile('rna_file')))).toContain('This is a SnapGene RNA file (.rna); only SnapGene DNA files (.dna) can be read.');
    expect(noRecord(parseSnapGene(file(cookie(), packet(0x00, []))))).toContain('The DNA sequence packet of the SnapGene file is empty (it lacks even its flags byte).');
    expect(noRecord(parseSnapGene(file(cookie(), packet(0x01, [0, 0, 0, 1]))))).toContain('The SnapGene file stores its sequence in a compressed packet (0x01), which is not supported.');
  });

  it('uses the first of several DNA packets and reads unusual cookies with warnings', () => {
    const two = readOne(caseFile('two_dna_packets'));
    expect(two.record.seq).toBe('ACGT');
    expect(two.warnings).toContain('The SnapGene file contains 2 DNA sequence packets; only the first was read.');
    expect(readOne(caseFile('short_cookie')).warnings[0]).toMatch(/cookie packet is 10 bytes long instead of 14/);
    expect(readOne(caseFile('unknown_sequence_type')).warnings[0]).toMatch(/Unknown sequence type 0/);
  });
});

describe('features', () => {
  const kan = readOne(fixture('pFA-KanMX4.dna'), 'pFA-KanMX4.dna').record;

  it('reads ranges as 0-based half-open segments and merges origin-spanning ranges into one segment', () => {
    // range="3925-2" on a 3941 bp circle: bases 3925..3941 and 1..2 (1-based)
    const sp6 = feature(kan, 'SP6 promoter');
    expect(sp6.segments).toEqual([{ start: 3924, end: 3943 }]);
    expect(featureSequence(sp6, kan.seq)).toBe(kan.seq.slice(3924) + kan.seq.slice(0, 2));
    expect(feature(kan, 'TEF promoter').segments).toEqual([{ start: 114, end: 458 }]);
    expect(readOne(fixture('looped_feature.dna')).record.features[0].segments).toEqual([{ start: 2, end: 12 }]);
    expect(readOne(fixture('looped_feature_origin.dna')).record.features[0].segments).toEqual([{ start: 0, end: 10 }]);
  });

  it('maps directionality to strands (1 -> 1, 2 -> -1, none/0/3 -> 0)', () => {
    expect(feature(kan, 'SP6 promoter').strand).toBe(1);
    expect(feature(kan, 'T7 promoter').strand).toBe(-1);
    expect(feature(kan, 'TEF terminator').strand).toBe(0);
    const { record, warnings } = readOne(caseFile('strands_frames'));
    expect(['no dir', 'dir 0', 'dir 1', 'dir 2', 'dir 3'].map((n) => feature(record, n).strand)).toEqual([0, 0, 1, -1, 0]);
    expect(warnings).toEqual(['Feature "frame conflict": /codon_start=3 disagrees with SnapGene\'s reading frame (readingFrame="2"); /codon_start was set to 2.']);
    expect(readOne(caseFile('ranges_invalid')).warnings).toContain('Feature "fine": unknown directionality "x"; read as non-directional.');
  });

  it('keeps SnapGene segment order (top-strand order) for reverse multi-segment features', () => {
    const { record } = readOne(fixture('sample-f.dna'));
    const reverse = feature(record, 'FeatureB');
    expect(reverse.strand).toBe(-1);
    // Segments 400-499, [gap 500-516], 517-634, 635-724 (1-based); the gap is not part of the feature.
    expect(reverse.segments).toEqual([
      { start: 399, end: 499 },
      { start: 516, end: 634 },
      { start: 634, end: 724 },
    ]);
    const parts = [record.seq.slice(399, 499), record.seq.slice(516, 634), record.seq.slice(634, 724)];
    expect(featureSequence(reverse, record.seq)).toBe(reverseComplement(parts.join('')));
    // Segment names, numbered 5'->3' along the feature (subfeature1 is the rightmost segment).
    expect(reverse.qualifiers[0]).toEqual({ key: 'parts', value: '1:subfeature1;3:subfeature3' });
    expect(feature(record, 'FeatureA').qualifiers[0]).toEqual({ key: 'parts', value: '2:subfeature2' });
    expect(feature(record, 'FeatureA').segments).toEqual([
      { start: 160, end: 180 },
      { start: 187, end: 207 },
      { start: 214, end: 241 },
    ]);
  });

  it('handles wrapping, adjacent, overlapping and single-base segments', () => {
    const { record } = readOne(caseFile('ranges_circular'));
    expect(feature(record, 'over origin').segments).toEqual([{ start: 280, end: 320 }]);
    expect(feature(record, 'full circle').segments).toEqual([{ start: 4, end: 304 }]);
    expect(feature(record, 'whole from origin').segments).toEqual([{ start: 0, end: 300 }]);
    expect(feature(record, 'split across origin').segments).toEqual([
      { start: 270, end: 290 },
      { start: 294, end: 310 },
      { start: 20, end: 60 },
    ]);
    expect(feature(record, 'reverse split').qualifiers.find((q) => q.key === 'parts')?.value).toBe('1:subfeature1;3:subfeature3');
    expect(feature(record, 'overlapping').segments).toEqual([
      { start: 235, end: 250 },
      { start: 249, end: 260 },
    ]);
    expect(feature(record, 'single base').segments).toEqual([{ start: 299, end: 300 }]);
  });

  it('splits a range that wraps a linear sequence, with a warning', () => {
    const { record, warnings } = readOne(caseFile('ranges_linear_wrap'));
    expect(record.features[0].segments).toEqual([
      { start: 290, end: 300 },
      { start: 0, end: 10 },
    ]);
    expect(warnings).toEqual(['Feature "wraps on linear": segment "291-10" crosses the origin of a linear sequence; split into two segments.']);
  });

  it('skips invalid segments and features without valid segments, with warnings', () => {
    const { record, warnings } = readOne(caseFile('ranges_invalid'));
    expect(record.features.map((f) => f.name)).toEqual(['zero', 'fine']);
    expect(feature(record, 'zero').segments).toEqual([{ start: 5, end: 10 }]);
    expect(warnings).toEqual([
      'Feature "zero": segment range "0-5" is not valid for this 60 bp sequence; segment skipped.',
      'Feature "too long": segment range "50-61" is not valid for this 60 bp sequence; segment skipped.',
      'Feature "too long" has no valid segment; feature skipped.',
      'Feature "not a range": segment range "abc" is not valid for this 60 bp sequence; segment skipped.',
      'Feature "not a range": segment range "7" is not valid for this 60 bp sequence; segment skipped.',
      'Feature "not a range": segment range "1-2-3" is not valid for this 60 bp sequence; segment skipped.',
      'Feature "not a range" has no valid segment; feature skipped.',
      'Feature "fine": unknown directionality "x"; read as non-directional.',
    ]);
    const gaps = readOne(caseFile('gap_only_feature'));
    expect(gaps.record.features.map((f) => f.name)).toEqual(['ok']);
    expect(gaps.warnings).toEqual(['Feature "only a gap" has no valid segment; feature skipped.']);
  });

  it('takes the colour of the first standard segment', () => {
    expect(feature(kan, 'ori').color).toBe('#ffff00');
    expect(feature(kan, 'KanR').color).toBe('#ccffcc');
    const { record } = readOne(caseFile('ranges_circular'));
    expect(feature(record, 'adjacent no gaps').color).toBe('#aabbcc'); // first segment "noColor", second "#ABC"
    expect(feature(record, 'non-adjacent without gap').color).toBe('#ff0000');
  });

  it('removes the HTML wrapper from qualifier values', () => {
    const { record } = readOne(fixture('linebreak_in_qualifier_text.dna'));
    expect(record.features[0].qualifiers).toEqual([
      { key: 'note', value: 'Origin of transference region of RP4 plasmid' },
      { key: 'label', value: 'oriT' },
    ]);
    expect(feature(kan, 'KanR').qualifiers).toEqual([
      { key: 'translation', value: expect.stringMatching(/^MGKEKTHVSRPRLNSNMDADLYGYK.*LMLDEFF$/) as unknown as string },
      { key: 'product', value: 'aminoglycoside phosphotransferase' },
      { key: 'note', value: 'confers resistance to kanamycin in bacteria or G418 (Geneticin®) in eukaryotes' },
      { key: 'transl_table', value: '1' },
      { key: 'codon_start', value: '1' },
      { key: 'gene', value: "aph(3')-Ia" },
      { key: 'label', value: 'KanR' },
    ]);
    const rich = readOne(caseFile('rich_text')).record;
    const values = rich.features[0].qualifiers.map((q) => q.value);
    expect(values).toEqual([
      'A & B <i> "q" it\'s',
      'Origin of transfer',
      'Welcome second line',
      'α-helix 37°C 5′→3′ μg α café',
      'see Kozak red',
      'styled para',
      'plain with newline and CRLF',
      '<unknown accession',
      "5' <- 3' & x > y",
      'β-lactamase µg/ml ≥ 5 naïve 🧬',
      "aph(3')-Ia",
      'Name & italic',
    ]);
    expect(rich.features[0].name).toBe('Name & italic');
    expect(rich.features[1].name).toBe('tab\there');
  });

  it('extracts CDS sequences whose translation is the /translation SnapGene stored', () => {
    // NCBI transl_table 1 (The Standard Code), codons in TCAG order.
    const code = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
    const index: Record<string, number> = { T: 0, C: 1, A: 2, G: 3 };
    const translate = (dna: string) => {
      let protein = '';
      for (let i = 0; i + 3 <= dna.length; i += 3) protein += code[index[dna[i]] * 16 + index[dna[i + 1]] * 4 + index[dna[i + 2]]];
      return protein;
    };
    const checked: string[] = [];
    for (const name of ['pFA-KanMX4.dna', 'sample-hybridization-params.dna']) {
      const { record } = readOne(fixture(name));
      for (const cds of record.features.filter((f) => f.type === 'CDS')) {
        const stored = cds.qualifiers.find((q) => q.key === 'translation')?.value ?? '';
        const codonStart = Number(cds.qualifiers.find((q) => q.key === 'codon_start')?.value ?? '1');
        expect(translate(featureSequence(cds, record.seq).slice(codonStart - 1)), cds.name).toBe(`${stored}*`);
        checked.push(`${cds.name} (strand ${cds.strand}, ${cds.segments.length} segment(s))`);
      }
    }
    expect(checked).toEqual(['KanR (strand 1, 1 segment(s))', 'AmpR (strand -1, 2 segment(s))', 'hht2-ORF (strand 1, 1 segment(s))']);
  });

  it('cleans /translation (SnapGene segment separators and final stop)', () => {
    const ampR = feature(kan, 'AmpR');
    const translation = ampR.qualifiers.find((q) => q.key === 'translation')?.value ?? '';
    expect(translation).toMatch(/^MSIQHFRVALIPFFAAFCLPVFAHPETLVKV/); // file: "...LPVFA,HPETL...KHW*"
    expect(translation).not.toMatch(/[,*]/);
    // Reverse CDS: the N-terminal signal peptide is the rightmost segment, i.e. segment 1 counted 5'->3'.
    expect(ampR.qualifiers[0]).toEqual({ key: 'parts', value: '1:signal sequence' });
  });

  it('turns SnapGene\'s "?" for an ambiguous codon into the INSDC "X" in /translation, matching translateFeature (reviewed defect)', () => {
    // Bases 1-12: ATG NCA AAA TAA; 13-21: reverse complement of ATG NCA AAA. SnapGene stored "M?K*", "M?,K*", "M?K".
    const { record, warnings } = readOne(caseFile('translation_ambiguous'));
    expect(warnings).toEqual([]);
    const stored = record.features.map((f) => f.qualifiers.find((q) => q.key === 'translation')?.value);
    expect(stored).toEqual(['MXK', 'MXK', 'MXK']);
    for (const cds of record.features) expect(translateFeature(record, cds, { toStop: true }), cds.name).toBe('MXK');
    // The reviewed reproduction: "M?*" on ATG NCA TAA.
    const small = readOne(file(cookie(), dna('ATGNCATAA'), features('<Feature name="orf" directionality="1" type="CDS"><Segment range="1-9" type="standard"/><Q name="translation"><V text="M?*"/></Q></Feature>')));
    expect(small.record.features[0].qualifiers[0]).toEqual({ key: 'translation', value: 'MX' });
  });

  it('reads every qualifier value form', () => {
    const { record } = readOne(caseFile('qualifier_forms'));
    expect(record.features[0].qualifiers).toEqual([
      { key: 'db_xref', value: 'GI:238030067' },
      { key: 'db_xref', value: 'GeneID:8197368' },
      { key: 'rpt_type', value: 'inverted' },
      { key: 'pseudo', value: null },
      { key: 'translation', value: 'MVTIGNAHDDL' },
      { key: 'codon_start', value: '1' },
      { key: 'transl_table', value: '11' },
      { key: 'note', value: 'first note' },
      { key: 'note', value: 'second note element (Biopython keeps only this one)' },
      { key: 'experiment', value: '' },
      { key: 'label', value: 'label one' },
      { key: 'label', value: 'label two' },
    ]);
  });

  it('records readingFrame 2/3 as /codon_start (SnapGene stores both, e.g. PlasmidPop frame_test.dna)', () => {
    const { record } = readOne(caseFile('strands_frames'));
    expect(feature(record, 'frame only').qualifiers).toEqual([
      { key: 'codon_start', value: '2' },
      { key: 'label', value: 'frame only' },
    ]);
    expect(feature(record, 'fwd frame 2').qualifiers[0]).toEqual({ key: 'codon_start', value: '2' });
    expect(feature(record, 'rev frame 3').qualifiers[0]).toEqual({ key: 'codon_start', value: '3' });
    // SnapGene translates in its readingFrame; a disagreeing /codon_start is stale (see 'reading frames').
    expect(feature(record, 'frame conflict').qualifiers[0]).toEqual({ key: 'codon_start', value: '2' });
  });

  it('makes the first /label equal the SnapGene name', () => {
    const d = readOne(fixture('sample-d.dna')).record;
    expect(feature(d, 'FeatureC').qualifiers.filter((q) => q.key === 'label')).toEqual([{ key: 'label', value: 'FeatureC' }]);
    expect(feature(d, 'FeatureD').qualifiers.filter((q) => q.key === 'label')).toEqual([
      { key: 'label', value: 'FeatureD' },
      { key: 'label', value: 'SampleFeatureD' },
    ]);
    const { record } = readOne(caseFile('names_labels'));
    expect(record.features.map((f) => [f.name, f.qualifiers.filter((q) => q.key === 'label').map((q) => q.value)])).toEqual([
      ['no label', ['no label']],
      ['same', ['same']],
      ['differs', ['differs', 'other']],
      ['later', ['later', 'first', 'later']],
      ['lacZ', []],
      ['promoter', []],
    ]);
  });
});

// --- reading frames -------------------------------------------------------------------------

/** NCBI translation table 1 (The Standard Code), codons in TCAG order. */
const STANDARD_CODE = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
const CODON_INDEX: Readonly<Record<string, number>> = { T: 0, C: 1, A: 2, G: 3 };

/** GenBank-style translation of a feature: from its /codon_start (default 1) up to the first stop codon. */
function translateToStop(record: SeqRecord, f: Feature): string {
  const codonStart = Number(f.qualifiers.find((q) => q.key === 'codon_start')?.value ?? '1');
  const dna = featureSequence(f, record.seq).slice(codonStart - 1);
  let protein = '';
  for (let i = 0; i + 3 <= dna.length; i += 3) {
    const aa = STANDARD_CODE[CODON_INDEX[dna[i]] * 16 + CODON_INDEX[dna[i + 1]] * 4 + CODON_INDEX[dna[i + 2]]];
    if (aa === '*') break;
    protein += aa;
  }
  return protein;
}

const codonStarts = (f: Feature) => f.qualifiers.filter((q) => q.key === 'codon_start').map((q) => q.value);

describe('reading frames (SnapGene readingFrame attribute vs /codon_start qualifier)', () => {
  // PMD20_LACZ / PMD19_LACZ: excerpts of SnapGene library files whose lacZα CDS has a stale
  // /codon_start=1 next to readingFrame="±2"; SnapGene's own /translation is frame 2 (see testkit).
  it('translates a forward CDS in SnapGene\'s readingFrame, replacing a stale /codon_start (T-Vector pMD20 lacZα)', () => {
    const { record, warnings } = readOne(libraryExcerptFile(PMD20_LACZ));
    const cds = record.features[0];
    expect(codonStarts(cds)).toEqual(['2']);
    expect(translateToStop(record, cds)).toBe(PMD20_LACZ.translation);
    expect(cds.qualifiers.find((q) => q.key === 'translation')?.value).toBe(translateToStop(record, cds));
    expect(warnings).toEqual(['Feature "lacZα": /codon_start=1 disagrees with SnapGene\'s reading frame (readingFrame="2"); /codon_start was set to 2.']);
  });

  it('translates a reverse CDS in SnapGene\'s readingFrame, replacing a stale /codon_start (T-Vector pMD19 (Simple) lacZα)', () => {
    const { record, warnings } = readOne(libraryExcerptFile(PMD19_LACZ));
    const cds = record.features[0];
    expect(cds.strand).toBe(-1);
    expect(codonStarts(cds)).toEqual(['2']);
    expect(translateToStop(record, cds)).toBe(PMD19_LACZ.translation);
    expect(cds.qualifiers.find((q) => q.key === 'translation')?.value).toBe(translateToStop(record, cds));
    expect(warnings).toEqual(['Feature "lacZα": /codon_start=1 disagrees with SnapGene\'s reading frame (readingFrame="-2"); /codon_start was set to 2.']);
  });

  it('keeps the position of the replaced /codon_start among the qualifiers', () => {
    const cds = readOne(libraryExcerptFile(PMD20_LACZ)).record.features[0];
    expect(cds.qualifiers.map((q) => q.key)).toEqual(['codon_start', 'transl_table', 'translation', 'label']);
  });

  it('applies the documented rules to every combination (case reading_frames.dna)', () => {
    const { record, warnings } = readOne(caseFile('reading_frames'));
    const frames = Object.fromEntries(record.features.map((f) => [f.name, codonStarts(f)]));
    expect(frames).toEqual({
      'fwd stale 1, frame 2': ['2'],
      'rev stale 1, frame -3': ['3'],
      'rev stale 2, frame -1': ['1'], // SnapGene's default reverse frame is a real frame: frame 1
      'rev agrees, frame -1': ['1'],
      'rev none, frame -1': [], // frame 1 adds nothing
      'fwd none, frame 3': ['3'],
      'fwd stale 3, no frame': ['3'], // no attribute (third-party writer, or forward frame 1): qualifier kept
      'rev stale 2, no frame': ['2'],
      'non-directional, frame -1': ['2'], // SnapGene writes -1 on non-directional features; it carries no frame
      'several values, frame 2': ['2'],
      'agrees with leading zero': ['02'],
      'value-less, frame 2': ['2'],
      'plus sign, frame +3': ['3'],
      'frame 0': ['2'],
      'frame 4': ['1'],
      'frame text': ['1'],
    });
    expect(warnings).toEqual([
      'Feature "fwd stale 1, frame 2": /codon_start=1 disagrees with SnapGene\'s reading frame (readingFrame="2"); /codon_start was set to 2.',
      'Feature "rev stale 1, frame -3": /codon_start=1 disagrees with SnapGene\'s reading frame (readingFrame="-3"); /codon_start was set to 3.',
      'Feature "rev stale 2, frame -1": /codon_start=2 disagrees with SnapGene\'s reading frame (readingFrame="-1"); /codon_start was set to 1.',
      'Feature "several values, frame 2": /codon_start values 2, 3 disagree with SnapGene\'s reading frame (readingFrame="2"); /codon_start was set to 2.',
      'Feature "value-less, frame 2": /codon_start without a value disagrees with SnapGene\'s reading frame (readingFrame="2"); /codon_start was set to 2.',
      'Feature "frame 0": readingFrame "0" is not a reading frame (±1, ±2 or ±3); ignored.',
      'Feature "frame 4": readingFrame "4" is not a reading frame (±1, ±2 or ±3); ignored.',
      'Feature "frame text": unreadable readingFrame "two"; ignored.',
    ]);
  });
});

describe('primers', () => {
  it('reads name, upper-cased sequence and description, ignoring binding sites', () => {
    const { record } = readOne(fixture('linebreak_in_qualifier_text.dna'));
    expect(record.primers.map(({ id, ...p }) => p)).toEqual([
      { name: 'AC4_Fragment.REV', sequence: 'TAATTATTGGGGACCCCTGGTATAAACGCAGAAAGGCCCACCC' },
      { name: 'P.SEVA.AbR.R', sequence: 'TCGCTATAATGACCCCGAAGC', description: '05/09/2017,Alex Primers 1,37' },
      { name: 'P.SEVA.ORI.F', sequence: 'CGGTGCTCAACGGGAATC', description: '03/08/2017,Alex Primers 1,33' },
    ]);
    for (const p of record.primers) expect(p.id).toMatch(/^p_/);
  });

  it('cleans sequences, names unnamed primers and skips primers without bases', () => {
    const { record, warnings } = readOne(caseFile('primers'));
    expect(record.primers.map(({ id, ...p }) => p)).toEqual([
      { name: 'fwd', sequence: 'ACGTRYTT' },
      { name: 'rev & co', sequence: 'ACGT', description: 'For mutagenesis' },
      { name: 'Primer 3', sequence: 'GGGG', description: 'plain, description' },
      { name: 'with sites', sequence: 'GAATTCGGATCC' },
    ]);
    expect(warnings).toEqual([
      'Primer "rev & co": removed characters that are not nucleotide codes ("5", "\'", "-", "3").',
      'Primer "no sequence" has no sequence; skipped.',
      'Primer "only junk": removed characters that are not nucleotide codes ("1", "2", "3", "-", "x", "z").',
      'Primer "only junk" has no sequence; skipped.',
    ]);
  });
});

describe('notes', () => {
  it('maps the notes of the fixtures', () => {
    const d = readOne(fixture('sample-d.dna')).record;
    expect(d.description).toBe('Sample Sequence D');
    expect(d.meta).toEqual({
      comments: ['Sample Sequence D'],
      division: 'UNA',
      date: '07-JUL-2021',
      sourceFormat: 'snapgene',
      extras: {
        UUID: '5ea05e55-2222-4f00-832b-9a9cbaa09de5',
        Type: 'Natural',
        Created: '2019.8.3',
        'Created.UTC': '12:1:19',
        LastModified: '2021.7.7',
        'LastModified.UTC': '9:36:44',
        CreatedBy: 'Damien Goutte-Gattat',
        SequenceClass: 'UNA',
        TransformedInto: 'unspecified',
        Strandedness: 'double',
        DamMethylated: '0',
        DcmMethylated: '0',
        EcoKIMethylated: '0',
        UpstreamModification: 'Unmodified',
        DownstreamModification: 'Unmodified',
      },
    });
    const kan = readOne(fixture('pFA-KanMX4.dna')).record;
    expect(kan.description).toBe('Plasmid carrying the kanMX selector module conferring kanamycin resistance. Also known as pFA6a-kanMX4.');
    expect(kan.meta.organism).toBe('Saccharomyces cerevisiae');
    expect(kan.meta.division).toBe('SYN');
    expect(kan.meta.extras?.CustomMapLabel).toBe('pFA6-kanMX4');
    expect(kan.meta.extras?.References).toBe(
      'Wach A, Brachat A, Pöhlmann R, Philippsen P. New heterologous modules for classical or PCR-based gene disruptions in Saccharomyces cerevisiae. Yeast 1994;10:1793-808. PubMed 7747518.',
    );
  });

  it('maps every Notes field of a full notes packet', () => {
    const { record } = readOne(caseFile('notes_full'));
    expect(record.description).toBe('pUC cloning vector.');
    expect(record.meta).toMatchObject({ accession: 'L09137', organism: 'Escherichia coli', comments: ['See also GenBank accession L09137.'], division: 'SYN' });
    expect(record.meta.date).toBeUndefined(); // LastModified "2021.5.32" is not a date
    expect(record.meta.extras).toMatchObject({
      ConfirmedExperimentally: '1',
      UseCustomMapLabel: '1',
      CodeNumber: 'XYZ-1',
      CreatedBy: 'Lab & Co',
      LastModified: '2021.5.32',
      FutureField: 'some value',
      'FutureField.kind': 'x',
      'FutureField.level': '2',
    });
    expect(record.meta.extras?.EmptyField).toBeUndefined();
    expect(record.meta.extras?.Structured).toBeUndefined();
    expect(record.meta.extras?.References).toBe(
      'Norrander J, Kempe T, Messing J. Construction of improved M13 vectors. Gene. 1983 Dec;26(1):101-6. PubMed 6323249.\n' +
        'Stokes WA, Glick BS. MICA: desktop software. BMC Bioinformatics 2006 Oct 3;7:427. PubMed 17018144. doi:10.1186/1471-2105-7-427',
    );
  });

  it('renders rich-text descriptions and comments and derives division and date', () => {
    const { record } = readOne(caseFile('rich_text'));
    expect(record.description).toBe('Welcome to SnapGene Viewer! This sample file.');
    expect(record.meta.comments).toEqual(['Use the tabs. Sequence view shows:\n\n-- an intron\nVal at 1a\n\nLast line']);
    expect(record.meta.accession).toBe('<unknown');
    expect(record.meta.division).toBe('PHG'); // Type Natural, SequenceClass PHG
    expect(record.meta.date).toBe('19-JUN-2018');
    expect(record.meta.extras?.TransformedInto).toBe('DH5α');
  });

  it('merges several Notes packets in file order: later fields win, comments accumulate', () => {
    const { record, warnings } = readOne(caseFile('notes_two_packets'));
    expect(warnings).toEqual([]);
    expect(record.description).toBe('first description'); // the second packet has no Description
    expect(record.meta).toMatchObject({ comments: ['comment one', 'comment two'], organism: 'Escherichia coli', accession: 'X12345', division: 'SYN', date: '02-JAN-2020' });
    expect(record.meta.extras).toMatchObject({ Type: 'Synthetic', SequenceClass: 'PHG', CustomMapLabel: 'second', LastModified: '2020.1.2' });
    const later = readOne(file(cookie(), dna('ACGT'), notes('<Description>first</Description>'), notes('<Description>second</Description>'))).record;
    expect(later.description).toBe('second');
  });

  it('reads files from older SnapGene versions and third-party writers', () => {
    const { record, warnings } = readOne(caseFile('old_layout'));
    expect(warnings).toEqual([]);
    expect(record.seq).toMatch(/^[ACGT]+$/);
    expect(record.features[0].qualifiers).toEqual([
      { key: 'parts', value: '1:-35;3:-10' },
      { key: 'color', value: '#FF0000' },
      { key: 'label', value: 'lac promoter' },
    ]);
    expect(record.primers.map(({ id, ...p }) => p)).toEqual([{ name: 'M13 Forward', sequence: 'TGTAAAACGACGGCCAGT', description: 'In lacZ gene' }]);
    expect(record.meta.extras?.UpstreamModification).toBe('FivePrimePhosphorylated');
  });
});

describe('sticky ends', () => {
  const ends = (name: string) => readOne(caseFile(name)).record.ends;

  it('maps the signed stickiness to FragmentEnds (positive = 5′, negative = 3′ overhang)', () => {
    expect(ends('sticky_5prime_both')).toEqual({ left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } });
    expect(ends('sticky_3prime_both')).toEqual({ left: { kind: '3prime', length: 1 }, right: { kind: '3prime', length: 1 } });
    expect(ends('sticky_topo')).toEqual({ left: { kind: 'blunt', length: 0 }, right: { kind: '5prime', length: 4 } });
    expect(ends('sticky_mixed')).toEqual({ left: { kind: '3prime', length: 3 }, right: { kind: '5prime', length: 2 } });
    expect(readOne(fixture('sample-d.dna')).record.ends).toBeUndefined();
  });

  it('keeps the end modifications in meta.extras', () => {
    const { record } = readOne(caseFile('sticky_mixed'));
    expect(record.meta.extras?.UpstreamModification).toBe('FivePrimePhosphorylated');
    expect(record.meta.extras?.DownstreamModification).toBe('Unmodified');
  });

  it('ignores impossible sticky ends with a warning', () => {
    const circular = readOne(caseFile('sticky_invalid_circular'));
    expect(circular.record.ends).toBeUndefined();
    expect(circular.warnings).toEqual(['Ignored sticky ends (UpstreamStickiness=4, DownstreamStickiness=-4) on a circular sequence.']);
    const tooLong = readOne(caseFile('sticky_invalid_too_long'));
    expect(tooLong.record.ends).toBeUndefined();
    expect(tooLong.warnings[0]).toMatch(/cover the whole 8 bp sequence/);
    const text = readOne(caseFile('sticky_invalid_text'));
    expect(text.record.ends).toEqual({ left: { kind: 'blunt', length: 0 }, right: { kind: '5prime', length: 2 } });
    expect(text.warnings).toEqual(['Ignored the sequence property UpstreamStickiness="abc": not an integer.']);
  });
});

describe('container robustness', () => {
  it('skips unknown and empty packets', () => {
    const { record, warnings } = readOne(caseFile('unknown_packets'));
    expect(record.description).toBe('packets galore');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Could not read the features of the SnapGene file \(packet 0x0a at offset \d+: .*\); they were not imported\.$/);
  });

  it('keeps reading other packets when one XML packet is malformed or has the wrong root', () => {
    const malformed = readOne(caseFile('malformed_features_xml'));
    expect(malformed.record.description).toBe('notes still readable');
    expect(malformed.warnings[0]).toMatch(/^Could not read the features .*Expected closing tag/);
    const wrongRoot = readOne(caseFile('wrong_root'));
    expect(wrongRoot.warnings[0]).toMatch(/^Unexpected <Primers> element in the features packet 0x0a at offset \d+ \(expected <Features>\); not imported\.$/);
  });

  it('reports truncation', () => {
    const data = fixture('sample-d.dna');
    // Cut inside the DNA packet (bytes 19.. hold the 1001-byte DNA packet).
    expect(noRecord(parseSnapGene(data.subarray(0, 500)))).toContain('The SnapGene file ends inside its DNA sequence packet; the sequence is incomplete and was not read.');
    // Cut inside the features packet: the record is read without features.
    const result = parseSnapGene(data.subarray(0, 13100));
    expect(result.records[0].features).toEqual([]);
    expect(result.warnings[0].message).toMatch(/^SnapGene file is truncated: packet 0x0a at offset 13004 declares 1574 byte\(s\) but only 91 remain; packet ignored\.$/);
    expect(noRecord(parseSnapGene(data.subarray(0, 16)))).toContain('The SnapGene file is truncated or damaged inside its cookie packet.');
    // The DNA packet occupies bytes 19..1024; cut 2 bytes into the next packet header.
    const header = parseSnapGene(data.subarray(0, 1027));
    expect(header.records).toHaveLength(1);
    expect(header.warnings[0].message).toBe('SnapGene file is truncated: 2 trailing byte(s) at offset 1025 do not form a complete packet header; ignored.');
  });

  it('decodes XML packets as UTF-8, dropping a byte order mark and replacing invalid bytes', () => {
    const bom = readOne(file(cookie(), dna('ACGT'), packet(0x06, bytes([0xef, 0xbb, 0xbf], '<Notes><Description>with BOM</Description></Notes>'))));
    expect(bom.record.description).toBe('with BOM');
    expect(bom.warnings).toEqual([]);
    const invalid = readOne(file(cookie(), dna('ACGT'), packet(0x06, bytes('<Notes><Description>bad ', [0xff, 0xc3], ' byte</Description></Notes>'))));
    expect(invalid.record.description).toBe('bad \ufffd\ufffd byte');
    expect(invalid.warnings).toEqual(['The notes packet (packet 0x06 at offset 29) is not valid UTF-8: 2 invalid byte sequence(s) were replaced by U+FFFD.']);
    // U+FFFD written as valid UTF-8 (EF BF BD) is ordinary text, not a decoding error.
    const literal = readOne(file(cookie(), dna('ACGT'), notes('<Description>kept \ufffd</Description>')));
    expect(literal.record.description).toBe('kept \ufffd');
    expect(literal.warnings).toEqual([]);
  });

  it('never expands DOCTYPE entities and survives element names that are dangerous in JavaScript', () => {
    const laughs = '<!DOCTYPE Notes [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>';
    const { record } = readOne(file(cookie(), dna('ACGT'), packet(0x06, `${laughs}<Notes><Description>&c;</Description></Notes>`)));
    expect(record.description).toBe('&c;');
    const proto = readOne(file(cookie(), dna('ACGT'), notes('<__proto__>x</__proto__><Description>ok</Description>')));
    expect(proto.record.description).toBe('');
    expect(proto.warnings[0]).toMatch(/^Could not read the notes/);
    expect(Object.getPrototypeOf(proto.record.meta.extras)).toBe(Object.prototype);
  });

  it('reads CDATA literally', () => {
    const { record } = readOne(file(cookie(), dna('ACGT'), notes('<Description><![CDATA[A &amp; B]]></Description>')));
    expect(record.description).toBe('A &amp; B');
  });

  it('reads features from several feature packets in file order', () => {
    const { record } = readOne(
      file(cookie(), dna('ACGTACGTAC'), features('<Feature name="one" type="misc_feature"><Segment range="1-2"/></Feature>'), features('<Feature name="two"><Segment range="3-4" type="standard"/></Feature>')),
    );
    expect(record.features.map((f) => [f.name, f.type])).toEqual([
      ['one', 'misc_feature'],
      ['two', 'misc_feature'],
    ]);
  });

  it('does not modify its input and is deterministic up to ids', () => {
    const data = fixture('pFA-KanMX4.dna');
    const copy = data.slice();
    const a = parseSnapGene(data).records[0];
    const b = parseSnapGene(data).records[0];
    expect(data).toEqual(copy);
    const strip = (r: SeqRecord) => ({ ...r, id: '', features: r.features.map((f) => ({ ...f, id: '' })), primers: r.primers.map((p) => ({ ...p, id: '' })) });
    expect(strip(a)).toEqual(strip(b));
    expect(new Set(a.features.map((f) => f.id)).size).toBe(a.features.length);
  });
});
