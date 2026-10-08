import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, SeqRecord } from '../types';
import { makeFeature, makeRecord } from '../seq/features';
import { GENBANK_EXTRA_KEYS, parseGenbank, writeGenbank } from './genbank';
import { normalizeColor } from './genbank-colors';
import { formatQualifier, wrapLocation } from './genbank-features';
import { formatLocusLine, moleculeTypeOfToken, normalizeGenbankDate, parseLocusLine } from './genbank-locus';
import { cleanResidues, detectMolecule, formatOrigin } from './genbank-sequence';

const FIXTURES = join(__dirname, '../../test/fixtures/genbank');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const gb = (...lines: string[]) => lines.join('\n') + '\n';

const LOCUS = 'LOCUS       test                      12 bp    DNA     linear   SYN 01-JAN-2020';
const ORIGIN = ['ORIGIN', '        1 acgtacgtac gt', '//'];

/** Parse text that must contain exactly one record. */
function one(text: string) {
  const r = parseGenbank(text);
  expect(r.records).toHaveLength(1);
  return { record: r.records[0], warnings: r.warnings };
}

function featuresOf(...featureLines: string[]) {
  return one(gb(LOCUS, 'FEATURES             Location/Qualifiers', ...featureLines, ...ORIGIN));
}

// ---------------------------------------------------------------------------
// Reader: files and records
// ---------------------------------------------------------------------------

describe('parseGenbank: files and records', () => {
  it('returns no record and one warning when there is no LOCUS line', () => {
    for (const text of ['', '\n\n', '>fasta\nACGT\n', 'hello world']) {
      const r = parseGenbank(text);
      expect(r.records).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0].message).toMatch(/LOCUS/);
    }
  });

  it('reads a minimal record', () => {
    const { record, warnings } = one(gb(LOCUS, 'DEFINITION  A test.', ...ORIGIN));
    expect(warnings).toEqual([]);
    expect(record.name).toBe('test');
    expect(record.description).toBe('A test');
    expect(record.seq).toBe('ACGTACGTACGT');
    expect(record.topology).toBe('linear');
    expect(record.molecule).toBe('DNA');
    expect(record.features).toEqual([]);
    expect(record.primers).toEqual([]);
    expect(record.meta.sourceFormat).toBe('genbank');
    expect(record.meta.date).toBe('01-JAN-2020');
    expect(record.meta.division).toBe('SYN');
    expect(record.id).toMatch(/^doc_/);
  });

  it('accepts CRLF, CR, a BOM, tabs and trailing blanks', () => {
    const lf = gb(
      LOCUS,
      'DEFINITION  Two line',
      '            definition.',
      'FEATURES             Location/Qualifiers',
      '     gene            1..4',
      '                     /gene="abc"',
      ...ORIGIN,
    );
    const base = one(lf).record;
    const variants = [
      lf.replace(/\n/g, '\r\n'),
      lf.replace(/\n/g, '\r'),
      '﻿' + lf,
      lf.replace(/\n/g, '   \t\n'),
      lf.replace('                     /gene', '\t\t\t     /gene'),
    ];
    for (const v of variants) {
      const { record, warnings } = one(v);
      expect(warnings).toEqual([]);
      expect({ ...record, id: '', features: record.features.map((f) => ({ ...f, id: '' })) }).toEqual({
        ...base,
        id: '',
        features: base.features.map((f) => ({ ...f, id: '' })),
      });
    }
  });

  it('reads records of concatenated files that each start with a BOM (review finding)', () => {
    // `cat a.gb b.gb` of BOM-prefixed exports, decoded by TextDecoder (which strips only the first BOM)
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const bytes = Buffer.concat([bom, Buffer.from(fixture('pUC19_M77789.gb')), bom, Buffer.from(fixture('pBR322_J01749.gb'))]);
    const r = parseGenbank(new TextDecoder().decode(bytes));
    expect(r.records.map((x) => x.name)).toEqual(['SYNPUC19V', 'SYNPBR322']);
    expect(r.warnings).toEqual([]);
    const single = parseGenbank(fixture('pBR322_J01749.gb')).records[0];
    const strip = (x: SeqRecord) => ({ ...x, id: '', features: x.features.map((f) => ({ ...f, id: '' })) });
    expect(strip(r.records[1])).toEqual(strip(single));
    // a BOM at the start of any other line is not data either
    const { record, warnings } = one(gb(LOCUS, '﻿DEFINITION  A test.', 'ORIGIN', '﻿        1 acgtacgtac gt', '//'));
    expect(warnings).toEqual([]);
    expect(record.description).toBe('A test');
    expect(record.seq).toBe('ACGTACGTACGT');
  });

  it('reads every record of a multi-record file', () => {
    const r = parseGenbank(fixture('cor6_6.gb'));
    expect(r.records.map((x) => x.name)).toEqual(['ATCOR66M', 'ATKIN2', 'BNAKINI', 'ARU237582', 'BRRBIF72', 'AF297471']);
    expect(r.warnings).toEqual([]);
  });

  it('warns about a missing // and still separates records', () => {
    const text = gb(LOCUS, 'ORIGIN', '        1 acgt', LOCUS.replace('test', 'two '), ...ORIGIN);
    const r = parseGenbank(text);
    expect(r.records.map((x) => x.name)).toEqual(['test', 'two']);
    expect(r.records[0].seq).toBe('ACGT');
    expect(r.warnings.some((w) => /not terminated/.test(w.message) && w.recordIndex === 0 && w.line === 3)).toBe(true);
    const last = parseGenbank(fixture('no_end_marker.gb'));
    expect(last.records[0].seq).toHaveLength(6497);
    expect(last.warnings.map((w) => w.message)).toEqual(["record is not terminated by '//'"]);
  });

  it('ignores (with a warning) text before the first LOCUS line and between records', () => {
    const text = gb('Some preamble', '', LOCUS, ...ORIGIN, 'junk', LOCUS, ...ORIGIN);
    const r = parseGenbank(text);
    expect(r.records).toHaveLength(2);
    expect(r.warnings.map((w) => w.line)).toEqual([1, 7]);
  });

  it('fills a missing ORIGIN with N of the LOCUS length (no_origin_no_end.gb)', () => {
    const r = parseGenbank(fixture('no_origin_no_end.gb'));
    expect(r.records).toHaveLength(1);
    expect(r.records[0].seq).toBe('N'.repeat(6497));
    expect(r.records[0].features[0].segments).toEqual([{ start: 0, end: 6497 }]);
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/no ORIGIN/);
  });

  it('reads sequence lines whose ORIGIN keyword line is missing, recognised by their numbering', () => {
    const features = ['FEATURES             Location/Qualifiers', '     gene            1..4', '                     /gene="abc"'];
    const sequence = ['        1 acgtacgtac gt'];
    const base = one(gb(LOCUS, ...features, 'ORIGIN', ...sequence, '//')).record;
    const strip = (x: SeqRecord) => ({ ...x, id: '', features: x.features.map((f) => ({ ...f, id: '' })) });
    // ORIGIN line deleted: same record, one warning at the first sequence line
    const lost = one(gb(LOCUS, ...features, ...sequence, '//'));
    expect(strip(lost.record)).toEqual(strip(base));
    expect(lost.warnings).toEqual([
      { message: 'no ORIGIN line: the 1 numbered sequence line(s) from line 5 were read as the sequence', line: 5, recordIndex: 0 },
    ]);
    // ORIGIN keyword indented or misspelled: same, plus a warning about that line
    for (const keyword of [' ORIGIN', 'ORIGN']) {
      const r = one(gb(LOCUS, ...features, keyword, ...sequence, '//'));
      expect(strip(r.record)).toEqual(strip(base));
      expect(r.warnings.map((w) => w.line)).toEqual([5, 6]);
    }
    // real files: other indentation (wrong_sequence_indent.gb), a number-only last line and
    // a protein (blank_seq.gb), several records (cor6_6.gb), no // either (no_end_marker.gb)
    for (const file of ['wrong_sequence_indent.gb', 'blank_seq.gb', 'cor6_6.gb', 'no_end_marker.gb', 'pUC19_M77789.gb']) {
      const text = fixture(file);
      const original = parseGenbank(text);
      const withoutOrigin = parseGenbank(text.replace(/^ORIGIN.*$/gm, ''));
      expect(withoutOrigin.records.map(strip)).toEqual(original.records.map(strip));
      const recovered = withoutOrigin.warnings.filter((w) => /^no ORIGIN line/.test(w.message));
      expect(recovered).toHaveLength(original.records.length);
      expect(withoutOrigin.warnings.length).toBe(original.warnings.length + recovered.length);
    }
  });

  it('does not guess a sequence from lines that do not number a complete block', () => {
    const header = [LOCUS, 'FEATURES             Location/Qualifiers', '     gene            1..4'];
    const cases: [string, string[]][] = [
      ['does not start at base 1 (head lost)', ['       61 acgtacgtac gt']],
      ['a line is missing inside', ['        1 acgtacgtac', '       21 acgtacgtac']],
      ['a line has too many residues', ['        1 acgtacgtac gt', '       12 acgt']],
      ['indented like header text', ['            1 acgtacgtac gt']],
      ['not only residues', ['        1 acgtacgtac g-']],
      ['numbers only', ['        1']],
    ];
    for (const [why, lines] of cases) {
      const r = one(gb(...header, ...lines, '//'));
      expect({ why, seq: r.record.seq }).toEqual({ why, seq: 'N'.repeat(12) });
      expect(r.warnings.some((w) => /no ORIGIN sequence section/.test(w.message))).toBe(true);
    }
    // a COMMENT that ends with numbered text is not a sequence either
    const comment = one(gb(LOCUS, 'COMMENT     Steps:', '            1 digest', '//'));
    expect(comment.record.meta.comments).toEqual(['Steps:\n1 digest']);
    expect(comment.record.seq).toBe('N'.repeat(12));
  });

  it('uses a placeholder for CONTIG-only records (DS830848.gb, bad_origin_wrap.gb)', () => {
    for (const [file, n] of [
      ['DS830848.gb', 1311],
      ['bad_origin_wrap.gb', 7000],
    ] as const) {
      const r = parseGenbank(fixture(file));
      expect(r.records[0].seq).toBe('N'.repeat(n));
      expect(r.warnings.some((w) => /CONTIG/.test(w.message))).toBe(true);
    }
    const protein = one(gb('LOCUS       p                          5 aa            linear   PRI 01-JAN-2020', '//'));
    expect(protein.record.seq).toBe('XXXXX');
  });

  it('does not try to build a placeholder for an absurd LOCUS length', () => {
    const { record, warnings } = one(gb('LOCUS       big 99999999999 bp DNA linear SYN 01-JAN-2020', 'FEATURES             Location/Qualifiers', '     gene            1..10', '//'));
    expect(record.seq).toBe('');
    expect(record.features).toEqual([]);
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/too large for a placeholder/);
  });

  it("ends records only at '//' in column 1 and normalizes valid LOCUS dates", () => {
    const { record } = one(gb('LOCUS       x 12 bp DNA linear SYN 1-jan-2001', 'COMMENT     first', '            //', '            last', ...ORIGIN));
    expect(record.meta.comments).toEqual(['first\n//\nlast']);
    expect(record.meta.date).toBe('01-JAN-2001');
    expect(record.seq).toHaveLength(12);
  });

  it('reads an empty sequence', () => {
    const { record, warnings } = one(gb('LOCUS       e                          0 bp    DNA     linear   SYN 01-JAN-2020', 'ORIGIN', '//'));
    expect(record.seq).toBe('');
    expect(warnings).toEqual([]);
  });

  it('trusts the sequence when the LOCUS length disagrees', () => {
    const { record, warnings } = one(gb(LOCUS.replace('  12 bp', '  99 bp'), ...ORIGIN));
    expect(record.seq).toHaveLength(12);
    expect(warnings.map((w) => w.message)).toEqual(['LOCUS declares 99 bp but the sequence has 12; the sequence is used']);
    expect(warnings[0].line).toBe(1);
  });

  it('reads sequence lines with wrong indentation (wrong_sequence_indent.gb)', () => {
    const a = parseGenbank(fixture('wrong_sequence_indent.gb')).records[0];
    const b = parseGenbank(fixture('empty_feature_qualifier.gb')).records[0];
    expect(a.seq).toBe(b.seq);
  });

  it('upper-cases DNA, converts U to T, keeps U in RNA and reads proteins', () => {
    expect(one(gb(LOCUS, 'ORIGIN', '        1 acgu acgu', '//')).record.seq).toBe('ACGTACGT');
    const rna = one(gb('LOCUS       r                          4 bp    RNA     linear   SYN 01-JAN-2020', 'ORIGIN', '        1 acgu', '//'));
    expect(rna.record.molecule).toBe('RNA');
    expect(rna.record.seq).toBe('ACGU');
    const prot = parseGenbank(fixture('blank_seq.gb')).records[0];
    expect(prot.molecule).toBe('protein');
    expect(prot.seq.startsWith('MEECWVTEIANGSKDG')).toBe(true);
  });

  it('replaces invalid characters by N (protein: X) and reports the line', () => {
    const { record, warnings } = one(gb(LOCUS, 'ORIGIN', '        1 acgtacgtac', '       11 x-', '//'));
    expect(record.seq).toBe('ACGTACGTACNN');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/"x" \(1\), "-" \(1\)/);
    expect(warnings[0].line).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Reader: LOCUS and header
// ---------------------------------------------------------------------------

describe('parseLocusLine', () => {
  const cases: [string, object][] = [
    [
      'LOCUS       SYNPUC19V               2686 bp    DNA     circular SYN 07-AUG-2008',
      { name: 'SYNPUC19V', length: 2686, unit: 'bp', moleculeToken: 'DNA', topology: 'circular', division: 'SYN', date: '07-AUG-2008' },
    ],
    [
      'LOCUS       AC007323    86436 bp    DNA             PLN       19-JAN-2000',
      { name: 'AC007323', length: 86436, unit: 'bp', moleculeToken: 'DNA', division: 'PLN', date: '19-JAN-2000' },
    ],
    [
      'LOCUS       pFA6a-kanMX6                3938 bp ds-DNA     circular SYN 12-MAY-2021',
      { name: 'pFA6a-kanMX6', length: 3938, unit: 'bp', moleculeToken: 'ds-DNA', topology: 'circular', division: 'SYN', date: '12-MAY-2021' },
    ],
    [
      'LOCUS       NP_034640                182 aa                     ROD 01-NOV-2000',
      { name: 'NP_034640', length: 182, unit: 'aa', division: 'ROD', date: '01-NOV-2000' },
    ],
    ['LOCUS       pBAD30       4923 bp    DNA   circular            ', { name: 'pBAD30', length: 4923, unit: 'bp', moleculeToken: 'DNA', topology: 'circular' }],
    [
      'LOCUS       AZZZAA02123456789 10000000000 bp    DNA     linear   PRI 15-OCT-2018',
      { name: 'AZZZAA02123456789', length: 10000000000, unit: 'bp', moleculeToken: 'DNA', topology: 'linear', division: 'PRI', date: '15-OCT-2018' },
    ],
    ['LOCUS       ATCOR66M      513 bp    mRNA            PLN       02-MAR-1992', { moleculeToken: 'mRNA', division: 'PLN' }],
    ['LOCUS       x 5 bp ss-RNA circular VRL 1-Jan-2001', { moleculeToken: 'ss-RNA', topology: 'circular', date: '1-Jan-2001' }],
  ];
  for (const [line, expected] of cases) {
    it(line, () => {
      const r = parseLocusLine(line);
      expect(r.warnings).toEqual([]);
      expect(r.fields).toMatchObject(expected);
    });
  }

  it('warns about missing or unknown fields instead of failing', () => {
    expect(parseLocusLine('LOCUS       U00096').warnings).toEqual(['LOCUS line has no sequence length']);
    expect(parseLocusLine('LOCUS').warnings).toHaveLength(2);
    const r = parseLocusLine('LOCUS       x 10 bp DNA linear SYN 01-JAN-2000 extra stuff');
    expect(r.fields.length).toBe(10);
    expect(r.warnings).toEqual(['unrecognised LOCUS field(s): extra stuff']);
  });

  it('maps molecule tokens like Biopython', () => {
    expect(['DNA', 'ds-DNA', 'ss-DNA', 'cDNA', 'mRNA', 'NA'].map(moleculeTypeOfToken)).toEqual(Array(6).fill('DNA'));
    expect(['RNA', 'ss-RNA', 'tRNA', 'rRNA', 'cRNA', 'snoRNA'].map(moleculeTypeOfToken)).toEqual(Array(6).fill('RNA'));
    expect(moleculeTypeOfToken('protein')).toBe('protein');
    expect(moleculeTypeOfToken('XYZ')).toBeUndefined();
  });

  it('missing topology means linear; unit aa means protein', () => {
    const r = parseGenbank(fixture('arab1.gb')).records[0];
    expect(r.topology).toBe('linear');
    expect(parseGenbank(fixture('qualifier_escaping_read.gb')).records[0].molecule).toBe('protein');
  });

  it('keeps the LOCUS molecule token in meta.extras', () => {
    const r = parseGenbank(fixture('addgene-plasmid-39296-sequence-49545.gbk')).records[0];
    expect(r.meta.extras?.[GENBANK_EXTRA_KEYS.moleculeType]).toBe('ds-DNA');
    const m = parseGenbank(fixture('iro.gb')).records[0];
    expect(m.molecule).toBe('DNA');
    expect(m.meta.extras?.[GENBANK_EXTRA_KEYS.moleculeType]).toBe('mRNA');
  });
});

describe('parseGenbank: header', () => {
  it('reads DEFINITION, ACCESSION, VERSION, KEYWORDS, SOURCE, ORGANISM and lineage', () => {
    const r = parseGenbank(fixture('pBR322_J01749.gb')).records[0];
    expect(r.description).toBe('Cloning vector pBR322, complete sequence');
    expect(r.meta.accession).toBe('J01749 K00005 L08654 M10282 M10283 M10286 M10356 M10784 M10785 M10786 M33694 V01119');
    expect(r.meta.version).toBe('J01749.1');
    expect(r.meta.keywords).toBe(
      'ampicillin resistance; beta-lactamase; cloning vector; drug resistance protein; origin of replication; ' +
        'plasmid; tetracycline resistance',
    );
    expect(r.meta.source).toBe('Cloning vector pBR322');
    expect(r.meta.organism).toBe('Cloning vector pBR322');
    expect(r.meta.extras?.[GENBANK_EXTRA_KEYS.taxonomy]).toBe('other sequences; artificial sequences; vectors.');
  });

  it("treats '.' and empty values as absent", () => {
    const r = parseGenbank(fixture('bad_loc_wrap.gb')).records[0];
    expect(r.meta.source).toBeUndefined();
    expect(r.meta.organism).toBeUndefined();
    expect(r.meta.extras?.[GENBANK_EXTRA_KEYS.taxonomy]).toBeUndefined();
    const v = parseGenbank(fixture('pBAD30.gb')).records[0];
    expect(v.meta.source).toBeUndefined();
    expect(v.meta.accession).toBeUndefined();
    expect(v.description).toBe('');
  });

  it('keeps a multi-line organism name apart from the lineage', () => {
    const { record } = one(
      gb(
        LOCUS,
        'SOURCE      x',
        '  ORGANISM  Influenza A virus (A/swine/Some Very Long Place Name/123456/2009',
        '            (H1N1))',
        '            Viruses; Riboviria; Orthornavirae.',
        ...ORIGIN,
      ),
    );
    expect(record.meta.organism).toBe('Influenza A virus (A/swine/Some Very Long Place Name/123456/2009 (H1N1))');
    expect(record.meta.extras?.[GENBANK_EXTRA_KEYS.taxonomy]).toBe('Viruses; Riboviria; Orthornavirae.');
  });

  it('keeps COMMENT blocks with their line structure', () => {
    const r = parseGenbank(fixture('pBAD30.gb')).records[0];
    expect(r.meta.comments).toEqual([
      'This file is best viewed with a free Vector NTI Viewer:',
      'This file is created by Vector NTI\nhttp://www.informaxinc.com/',
      'ORIGDB|GenBank',
      'VNTREPLTYPE|Phagemid',
      'VNTEXTCHREPL|Bacteria',
    ]);
    const s = parseGenbank(fixture('EU851978.gbk')).records[0];
    expect(s.meta.comments?.[0].split('\n')[1]).toBe('LabID             :: 2008704957');
    const blank = parseGenbank(fixture('DS830848.gb')).records[0].meta.comments?.[0].split('\n') ?? [];
    expect(blank[0]).toBe('');
    expect(blank).toContain('');
    expect(blank[blank.length - 1]).toBe('Annotation was added to the scaffolds in December 2008.');
  });

  it('keeps every other header block verbatim and in order', () => {
    const r = parseGenbank(fixture('blank_seq.gb')).records[0];
    const extra = r.meta.extraHeaderLines ?? [];
    expect(extra[0]).toBe('PID         g4502929');
    expect(extra[1]).toBe('DBSOURCE    REFSEQ: accession NM_001841.1');
    expect(extra[2]).toBe('REFERENCE   1  (residues 1 to 360)');
    expect(extra.filter((l) => l.startsWith('REFERENCE'))).toHaveLength(3);
    expect(extra).toContain('   PUBMED   7689702');
    const source = fixture('blank_seq.gb').split('\n');
    for (const line of extra) expect(source).toContain(line);
  });

  it('warns about repeated single-valued blocks', () => {
    const { record, warnings } = one(gb(LOCUS, 'VERSION     A.1', 'VERSION     B.2', ...ORIGIN));
    expect(record.meta.version).toBe('A.1');
    expect(warnings).toEqual([{ message: 'repeated VERSION block ignored', line: 3, recordIndex: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// Reader: features
// ---------------------------------------------------------------------------

describe('parseGenbank: features', () => {
  it('reads keys, locations, strands and derived names', () => {
    const { record, warnings } = featuresOf(
      '     promoter        1..4',
      '                     /label=Plac',
      '     CDS             complement(join(1..3,7..12))',
      '                     /gene="abc"',
      '                     /product="Abc protein"',
    );
    expect(warnings).toEqual([]);
    const [p, c] = record.features;
    expect(p).toMatchObject({ type: 'promoter', name: 'Plac', strand: 1, segments: [{ start: 0, end: 4 }] });
    expect(c).toMatchObject({ type: 'CDS', name: 'abc', strand: -1, segments: [{ start: 0, end: 3 }, { start: 6, end: 12 }] });
    expect(p.id).toMatch(/^f_/);
    expect(p.id).not.toBe(c.id);
    expect(p.partialStart).toBeUndefined();
  });

  it('reads locations continued on several lines (also broken inside a number)', () => {
    const { record } = featuresOf(
      '     CDS             join(1..2,',
      '                     4..5,7',
      '                     ..8)',
      '                     /note="x"',
    );
    expect(record.features[0].segments).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
    const wrap = parseGenbank(fixture('bad_loc_wrap.gb')).records[0].features[0];
    expect(wrap.segments[4]).toEqual({ start: 4875, end: 5028 });
  });

  it('reads quoted, escaped, unquoted, value-less and empty qualifiers', () => {
    const { record } = featuresOf(
      '     CDS             1..12',
      '                     /codon_start=1',
      '                     /transl_table=11',
      '                     /note="He said ""hi"" twice"',
      '                     /label=two words',
      '                     /pseudo',
      '                     /note=',
      '                     /anticodon=(pos:1..3,aa:Met,seq:cat)',
      '                     /product = "spaced"',
    );
    expect(record.features[0].qualifiers).toEqual([
      { key: 'codon_start', value: '1' },
      { key: 'transl_table', value: '11' },
      { key: 'note', value: 'He said "hi" twice' },
      { key: 'label', value: 'two words' },
      { key: 'pseudo', value: null },
      { key: 'note', value: '' },
      { key: 'anticodon', value: '(pos:1..3,aa:Met,seq:cat)' },
      { key: 'product', value: 'spaced' },
    ]);
  });

  it('joins multi-line values with one space, /translation without spaces', () => {
    const { record } = featuresOf(
      '     CDS             1..12',
      '                     /note="first line   ',
      '                         second line"',
      '                     /translation="MKV',
      '                     LLA"',
      '                     /ApEinfo_graphicformat=arrow_data {{0 1 2 0 0 -1} {} 0}',
      '                     width 5 offset 0',
      '                     /gene="a ""quoted""',
      '                     word"',
    );
    expect(record.features[0].qualifiers).toEqual([
      { key: 'note', value: 'first line second line' },
      { key: 'translation', value: 'MKVLLA' },
      { key: 'gene', value: 'a "quoted" word' },
    ]);
  });

  it('reads malformed escaping like Biopython (qualifier_escaping_read.gb)', () => {
    const r = parseGenbank(fixture('qualifier_escaping_read.gb'));
    const notes = r.records[0].features.flatMap((f) => f.qualifiers.filter((q) => q.key === 'note').map((q) => q.value));
    expect(notes).toEqual([
      '"This" is "already" "escaped"',
      'One missing "quotation mark" here',
      'End not properly "escaped"',
      '"Start" not properly escaped',
    ]);
    expect(r.warnings.filter((w) => /not escaped/.test(w.message)).map((w) => w.line)).toEqual([27, 29, 33, 36]);
  });

  it('reads a value-less qualifier after a valued one with the same key (empty_feature_qualifier.gb)', () => {
    const f = parseGenbank(fixture('empty_feature_qualifier.gb')).records[0].features[0];
    expect(f.qualifiers.slice(-2)).toEqual([
      { key: 'note', value: "This is a correct note, the following one isn't" },
      { key: 'note', value: null },
    ]);
  });

  it('turns ApE colour qualifiers into colours', () => {
    const { record, warnings } = featuresOf(
      '     misc_feature    1..4',
      '                     /label=a',
      '                     /ApEinfo_fwdcolor=cyan',
      '                     /ApEinfo_revcolor=#FF9CCD',
      '                     /ApEinfo_graphicformat=arrow_data {{0 1 2 0 0 -1} {} 0}',
      '                     width 5 offset 0',
      '     misc_feature    5..8',
      '                     /ApEinfo_fwdcolor="#f00"',
      '                     /ApEinfo_revcolor=red',
      '     misc_feature    9..12',
      '                     /ApEinfo_fwdcolor=notacolour',
    );
    const [a, b, c] = record.features;
    expect(a.color).toBe('#00ffff');
    expect(a.reverseColor).toBe('#ff9ccd');
    expect(a.qualifiers).toEqual([{ key: 'label', value: 'a' }]);
    expect(b.color).toBe('#ff0000');
    expect(b.reverseColor).toBeUndefined();
    expect(b.qualifiers).toEqual([]);
    expect(b.name).toBe('misc_feature');
    expect(c.color).toBeUndefined();
    expect(c.qualifiers).toEqual([{ key: 'ApEinfo_fwdcolor', value: 'notacolour' }]);
    expect(warnings.map((w) => w.line)).toEqual([12]); // the feature's key line
  });

  it('merges origin-spanning parts on circular records and marks fuzzy ends', () => {
    const r = parseGenbank(fixture('bad_origin_wrap_CDS.gb')).records[0];
    expect(r.features[1]).toMatchObject({ strand: -1, segments: [{ start: 237, end: 306 }] });
    expect(r.features[2]).toMatchObject({ strand: 1, segments: [{ start: 241, end: 301 }] });
    const fuzzy = parseGenbank(fixture('bad_origin_wrap_fuzzy.gb')).records[0].features[3];
    expect(fuzzy).toMatchObject({ segments: [{ start: 2643, end: 2845 }], partialStart: true });
    expect(fuzzy.partialEnd).toBeUndefined();
  });

  it('gives protein features strand 0', () => {
    const r = parseGenbank(fixture('dbsource_wrap.gb')).records[0];
    expect(r.features.every((f) => f.strand === 0)).toBe(true);
    expect(r.features[2].segments).toEqual([
      { start: 11, end: 12 },
      { start: 62, end: 63 },
    ]);
  });

  it('skips unusable features with a warning that has the line number', () => {
    const { record, warnings } = featuresOf(
      '     misc_feature    50..60',
      '     gene            garbage(',
      '     gene            X12345.1:1..10',
      '     gene            2..3',
    );
    expect(record.features.map((f) => f.type)).toEqual(['gene']);
    expect(warnings.map((w) => w.line)).toEqual([3, 4, 5]);
    expect(warnings.every((w) => /skipped/.test(w.message))).toBe(true);
  });

  it('keeps a feature whose key line has no location by reading the next line', () => {
    const { record } = featuresOf('     gene', '                     1..4', '                     /gene="g"');
    expect(record.features[0]).toMatchObject({ type: 'gene', name: 'g', segments: [{ start: 0, end: 4 }] });
  });

  it('reports fuzzy markers lost at the origin junction of a circular record (review finding)', () => {
    const locus = 'LOCUS       circ                     100 bp    DNA     circular SYN 01-JAN-2020';
    const origin = formatOrigin('ACGTACGTAC'.repeat(10));
    const r = parseGenbank(
      gb(locus, 'FEATURES             Location/Qualifiers', '     misc_feature    join(91..>100,<1..10)', '     misc_feature    complement(join(91..>100,<1..10))', ...origin, '//'),
    );
    expect(r.records[0].features.map((f) => [f.segments, f.partialStart, f.partialEnd])).toEqual([
      [[{ start: 90, end: 110 }], undefined, undefined],
      [[{ start: 90, end: 110 }], undefined, undefined],
    ]);
    expect(r.warnings.map((w) => [w.line, /fuzzy boundary inside/.test(w.message)])).toEqual([
      [3, true],
      [4, true],
    ]);
  });

  it('reports markers that point into the location, whose direction cannot be kept (review finding)', () => {
    const { record, warnings } = featuresOf('     misc_feature    >5..10', '     misc_feature    1..<9', '     misc_feature    complement(>3..12)');
    expect(record.features.map((f) => [f.partialStart, f.partialEnd])).toEqual([
      [true, undefined],
      [undefined, true],
      [true, undefined],
    ]);
    expect(warnings.map((w) => w.line)).toEqual([3, 4, 5]);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/'>5'.*'<5'/),
      expect.stringMatching(/'<9'.*'>9'/),
      expect.stringMatching(/'>3'.*'<3'/),
    ]);
    expect(write(record).match(/misc_feature {4}\S+/g)).toEqual(['misc_feature    <5..10', 'misc_feature    1..>9', 'misc_feature    complement(<3..12)']);
  });
});

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function plasmid(features: Feature[] = [], extra: Partial<SeqRecord> = {}): SeqRecord {
  return makeRecord({
    name: 'pTest',
    description: 'Test plasmid',
    seq: 'ACGT'.repeat(25),
    topology: 'circular',
    features,
    ...extra,
  });
}

const write = (r: SeqRecord, colorQualifiers?: boolean) => writeGenbank(r, { date: '08-OCT-2026', colorQualifiers });

describe('writeGenbank: layout', () => {
  it('writes the LOCUS line in the standard columns', () => {
    const line = write(plasmid()).split('\n')[0];
    expect(line).toBe('LOCUS       pTest                    100 bp    DNA     circular SYN 08-OCT-2026');
    expect(line).toHaveLength(79);
    expect(line.slice(29, 40).trim()).toBe('100');
    expect(line.slice(41, 43)).toBe('bp');
    expect(line.slice(47, 53).trim()).toBe('DNA');
    expect(line.slice(55, 63).trim()).toBe('circular');
    expect(line.slice(64, 67)).toBe('SYN');
    expect(line.slice(68, 79)).toBe('08-OCT-2026');
  });

  it('formats LOCUS names, molecule tokens and long fields', () => {
    const base = { length: 3938, unit: 'bp' as const, moleculeToken: 'ds-DNA', topology: 'circular' as const, division: 'SYN', date: '12-MAY-2021' };
    expect(formatLocusLine({ ...base, name: 'pFA6a kanMX6' })).toBe(
      'LOCUS       pFA6a_kanMX6            3938 bp ds-DNA     circular SYN 12-MAY-2021',
    );
    expect(formatLocusLine({ ...base, name: 'a-very-long-locus-name-indeed', length: 12345678 })).toBe(
      'LOCUS       a-very-long-locus-name-indeed 12345678 bp ds-DNA     circular SYN 12-MAY-2021',
    );
    expect(formatLocusLine({ ...base, name: '', unit: 'aa', moleculeToken: '', topology: 'linear' })).toBe(
      'LOCUS       Untitled                3938 aa            linear   SYN 12-MAY-2021',
    );
  });

  it('keeps the original date and division, else uses options.date / today and SYN', () => {
    expect(write(plasmid([], { meta: { date: '7-aug-2008', division: 'BCT' } })).split('\n')[0]).toMatch(/BCT 07-AUG-2008$/);
    expect(write(plasmid([], { meta: { division: 'PRO' } })).split('\n')[0]).toMatch(/BCT 08-OCT-2026$/);
    expect(write(plasmid([], { meta: { division: 'odd' } })).split('\n')[0]).toMatch(/SYN 08-OCT-2026$/);
    expect(writeGenbank(plasmid()).split('\n')[0]).toMatch(/SYN \d{2}-[A-Z]{3}-\d{4}$/);
    expect(writeGenbank(plasmid(), { date: 'yesterday' }).split('\n')[0]).toMatch(/SYN \d{2}-[A-Z]{3}-\d{4}$/);
    expect(normalizeGenbankDate('1-jan-2000')).toBe('01-JAN-2000');
    expect(normalizeGenbankDate('32-JAN-2000')).toBeUndefined();
    expect(normalizeGenbankDate('01-XYZ-2000')).toBeUndefined();
  });

  it("writes '.' defaults and wraps DEFINITION at 80 columns", () => {
    const description = 'word '.repeat(30).trim() + '.';
    const lines = write(plasmid([], { description })).split('\n');
    const at = lines.findIndex((l) => l.startsWith('DEFINITION'));
    expect(lines.slice(0, 8).map((l) => l.slice(0, 12))).toEqual([
      'LOCUS       ',
      'DEFINITION  ',
      '            ',
      '            ',
      'ACCESSION   ',
      'VERSION     ',
      'KEYWORDS    ',
      'SOURCE      ',
    ]);
    expect(lines[at + 2].endsWith('word..')).toBe(true);
    for (const l of lines.slice(0, 12)) expect(l.length).toBeLessThanOrEqual(80);
    expect(lines.slice(4, 9)).toEqual(['ACCESSION   .', 'VERSION     .', 'KEYWORDS    .', 'SOURCE      .', '  ORGANISM  .']);
  });

  it('places verbatim header blocks where NCBI puts them, keeping their order', () => {
    const meta = {
      extraHeaderLines: [
        'DBLINK      BioProject: PRJNA1',
        'REFERENCE   1  (bases 1 to 100)',
        '  AUTHORS   Someone,A.',
        'PRIMARY     TPA_SPAN  PRIMARY_IDENTIFIER PRIMARY_SPAN  COMP',
      ],
      comments: ['A comment.'],
      organism: 'Escherichia coli',
      extras: { [GENBANK_EXTRA_KEYS.taxonomy]: 'Bacteria; Pseudomonadota.' },
    };
    const lines = write(plasmid([], { meta })).split('\n');
    const header = lines.slice(1, lines.indexOf('FEATURES             Location/Qualifiers'));
    expect(header.map((l) => l.slice(0, 12).trim())).toEqual([
      'DEFINITION',
      'ACCESSION',
      'VERSION',
      'DBLINK',
      'KEYWORDS',
      'SOURCE',
      'ORGANISM',
      '',
      'REFERENCE',
      'AUTHORS',
      'COMMENT',
      'PRIMARY',
    ]);
    // a block found after a later one in the source stays after it
    const odd = write(plasmid([], { meta: { extraHeaderLines: ['REFERENCE   1', 'DBLINK      X: 1'] } })).split('\n');
    expect(odd.indexOf('DBLINK      X: 1')).toBe(odd.indexOf('REFERENCE   1') + 1);
  });

  it('writes the sequence in the ORIGIN layout and ends with //', () => {
    const text = write(plasmid());
    const lines = text.split('\n');
    expect(text.endsWith('\n//\n')).toBe(true);
    const origin = lines.indexOf('ORIGIN');
    expect(lines[origin + 1]).toBe('        1 acgtacgtac gtacgtacgt acgtacgtac gtacgtacgt acgtacgtac gtacgtacgt');
    expect(lines[origin + 2]).toBe('       61 acgtacgtac gtacgtacgt acgtacgtac gtacgtacgt');
    expect(formatOrigin('')).toEqual(['ORIGIN']);
    expect(formatOrigin('A'.repeat(61)).slice(-1)).toEqual(['       61 a']);
    expect(formatOrigin('A'.repeat(1_000_000_000 > 0 ? 125 : 0))[3]).toBe('      121 aaaaa');
  });

  it('writes protein records with aa and without complement()', () => {
    const r = makeRecord({
      name: 'P1',
      seq: 'MKV',
      molecule: 'protein',
      features: [makeFeature({ type: 'Region', strand: -1, segments: [{ start: 0, end: 2 }] })],
    });
    const lines = write(r).split('\n');
    expect(lines[0]).toBe('LOCUS       P1                         3 aa            linear   SYN 08-OCT-2026');
    expect(lines).toContain('     Region          1..2');
  });

  it('ignores sticky ends and primers, skips features without segments, does not mutate the input', () => {
    const f = makeFeature({ type: 'gene', name: 'g', segments: [{ start: 0, end: 4 }] });
    const r = plasmid([f, makeFeature({ type: 'gene', name: 'nothing', segments: [] })], {
      topology: 'linear',
      ends: { left: { kind: '5prime', length: 4 }, right: { kind: 'blunt', length: 0 } },
      primers: [{ id: 'p1', name: 'fwd', sequence: 'ACGT' }],
    });
    const snapshot = JSON.parse(JSON.stringify(r));
    const text = write(r);
    expect(JSON.parse(JSON.stringify(r))).toEqual(snapshot);
    expect(text).not.toMatch(/nothing|fwd/);
    expect(parseGenbank(text).records[0].features).toHaveLength(1);
  });
});

describe('writeGenbank: features', () => {
  it('round-trips a 1 bp circular record with a whole-molecule feature and the origin site', () => {
    const features = [
      makeFeature({ type: 'misc_feature', name: 'all', strand: -1, segments: [{ start: 0, end: 1 }] }),
      makeFeature({ type: 'misc_feature', name: 'origin', segments: [{ start: 0, end: 0 }] }),
    ];
    const r = makeRecord({ name: 'one', seq: 'G', topology: 'circular', features });
    const text = write(r);
    expect(text).toContain('     misc_feature    complement(1)\n');
    expect(text).toContain('     misc_feature    1^1\n');
    expect(text).toContain('        1 g\n//\n');
    const back = parseGenbank(text);
    expect(back.warnings).toEqual([]);
    expect(back.records[0].features.map((f) => [f.strand, f.segments])).toEqual([
      [-1, [{ start: 0, end: 1 }]],
      [1, [{ start: 0, end: 0 }]],
    ]);
  });

  it('writes locations: wrapping segments, complement(join), partial ends, sites', () => {
    const features = [
      makeFeature({ type: 'rep_origin', name: 'ori', strand: -1, segments: [{ start: 90, end: 110 }] }),
      { ...makeFeature({ type: 'CDS', name: 'c', strand: 1, segments: [{ start: 0, end: 10 }, { start: 20, end: 30 }] }), partialStart: true, partialEnd: true },
      makeFeature({ type: 'misc_feature', name: 's', strand: 1, segments: [{ start: 0, end: 0 }] }),
    ];
    const lines = write(plasmid(features)).split('\n');
    expect(lines).toContain('     rep_origin      complement(join(91..100,1..10))');
    expect(lines).toContain('     CDS             join(<1..10,21..>30)');
    expect(lines).toContain('     misc_feature    100^1');
  });

  it('wraps long locations after commas within 79 columns', () => {
    const segments = Array.from({ length: 30 }, (_, k) => ({ start: k * 3, end: k * 3 + 2 }));
    const lines = write(plasmid([makeFeature({ type: 'misc_feature', name: 'm', segments })])).split('\n');
    const at = lines.findIndex((l) => l.startsWith('     misc_feature'));
    const block = [lines[at]];
    for (let k = at + 1; lines[k].startsWith(' '.repeat(21)) && !lines[k].trim().startsWith('/'); k++) block.push(lines[k]);
    expect(block.length).toBeGreaterThan(2);
    for (const l of block) {
      expect(l.length).toBeLessThanOrEqual(79);
      if (l !== block[block.length - 1]) expect(l.endsWith(',')).toBe(true);
    }
    expect(wrapLocation('x'.repeat(100))).toEqual(['x'.repeat(100)]);
  });

  it('wraps qualifiers at column 79 without splitting words', () => {
    const value = 'The quick brown fox jumps over the lazy dog, '.repeat(6).trim();
    const lines = formatQualifier('note', value);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(79);
      expect(l.startsWith(' '.repeat(21))).toBe(true);
    }
    expect(lines.map((l) => l.slice(21)).join(' ')).toBe(`/note="${value}"`);
  });

  it('breaks /translation anywhere and lets unbreakable words overflow', () => {
    const lines = formatQualifier('translation', 'M'.repeat(150));
    // '/translation="' + 150 residues + '"' = 165 characters: 58 + 58 + 49 after the 21-column indent
    expect(lines.map((l) => l.length)).toEqual([79, 79, 70]);
    const long = formatQualifier('note', 'x'.repeat(100));
    expect(long).toEqual([' '.repeat(21) + `/note="${'x'.repeat(100)}"`]);
  });

  it('escapes quotes, leaves numeric qualifiers unquoted and writes value-less qualifiers', () => {
    expect(formatQualifier('note', 'say "hi"')).toEqual([' '.repeat(21) + '/note="say ""hi"""']);
    expect(formatQualifier('codon_start', '1')).toEqual([' '.repeat(21) + '/codon_start=1']);
    expect(formatQualifier('transl_table', 'eleven 11')).toEqual([' '.repeat(21) + '/transl_table="eleven 11"']);
    expect(formatQualifier('pseudo', null)).toEqual([' '.repeat(21) + '/pseudo']);
    expect(formatQualifier('note', '')).toEqual([' '.repeat(21) + '/note=""']);
    expect(formatQualifier('note', 'a\nb\r\nc')).toEqual([' '.repeat(21) + '/note="a b c"']);
    expect(formatQualifier('bad key', 'v')).toEqual([' '.repeat(21) + '/bad_key="v"']);
    expect(formatQualifier('a=b', 'v')).toEqual([' '.repeat(21) + '/a_b="v"']);
  });

  it('never starts a continuation line with / or " and never ends one with "', () => {
    const value = 'see /path/to/file and "quoted" text '.repeat(8).trim();
    const lines = formatQualifier('note', value);
    for (const l of lines.slice(1)) {
      expect(l.slice(21, 22)).not.toMatch(/[/"]/);
    }
    for (const l of lines.slice(0, -1)) expect(l.endsWith('"')).toBe(false);
  });

  it('writes feature keys that read back as keys', () => {
    const odd = [
      makeFeature({ type: '/weird', name: 'w', segments: [{ start: 0, end: 4 }] }),
      makeFeature({ type: 'two words', name: 't', segments: [{ start: 0, end: 4 }] }),
      makeFeature({ type: '  ', name: 'e', segments: [{ start: 0, end: 4 }] }),
      makeFeature({ type: 'a_very_long_feature_key', name: 'l', segments: [{ start: 0, end: 4 }] }),
    ];
    const back = parseGenbank(write(plasmid(odd))).records[0].features;
    expect(back.map((f) => [f.type, f.name])).toEqual([
      ['weird', 'w'],
      ['two_words', 't'],
      ['misc_feature', 'e'],
      ['a_very_long_feature_key', 'l'],
    ]);
  });

  it('writes a /label when the name is not derived from the qualifiers', () => {
    const renamed = { ...makeFeature({ type: 'CDS', segments: [{ start: 0, end: 9 }], qualifiers: [{ key: 'gene', value: 'bla' }] }), name: 'AmpR' };
    const kept = makeFeature({ type: 'CDS', segments: [{ start: 0, end: 9 }], qualifiers: [{ key: 'gene', value: 'bla' }] });
    const relabel = { ...makeFeature({ type: 'CDS', segments: [{ start: 0, end: 9 }], qualifiers: [{ key: 'label', value: 'old' }] }), name: 'new' };
    const text = write(plasmid([renamed, kept, relabel]));
    const back = parseGenbank(text).records[0].features;
    expect(back.map((f) => f.name)).toEqual(['AmpR', 'bla', 'new']);
    expect(back[0].qualifiers).toEqual([
      { key: 'label', value: 'AmpR' },
      { key: 'gene', value: 'bla' },
    ]);
    expect(back[1].qualifiers).toEqual([{ key: 'gene', value: 'bla' }]);
    expect(back[2].qualifiers).toEqual([{ key: 'label', value: 'new' }]);
  });

  it('writes colours as ApE qualifiers unless colorQualifiers is false', () => {
    const coloured = { ...makeFeature({ type: 'misc_feature', name: 'c', segments: [{ start: 0, end: 4 }] }), color: '#ff0000' };
    const both = { ...coloured, reverseColor: '#00ff00' };
    const text = write(plasmid([coloured, both]));
    expect(text).toContain('/ApEinfo_fwdcolor=#ff0000\n                     /ApEinfo_revcolor=#ff0000');
    expect(text).toContain('/ApEinfo_revcolor=#00ff00');
    const back = parseGenbank(text).records[0].features;
    expect(back[0].color).toBe('#ff0000');
    expect(back[0].reverseColor).toBeUndefined();
    expect(back[1].reverseColor).toBe('#00ff00');
    const plain = write(plasmid([{ ...both, qualifiers: [...both.qualifiers, { key: 'ApEinfo_graphicformat', value: 'x' }] }]), false);
    expect(plain).not.toMatch(/ApEinfo/);
  });
});

describe('colour normalization', () => {
  it('accepts hex forms and CSS / Tk colour names', () => {
    expect(normalizeColor('#FF9CCD')).toBe('#ff9ccd');
    expect(normalizeColor('#f0c')).toBe('#ff00cc');
    expect(normalizeColor('#f0c8')).toBe('#ff00cc');
    expect(normalizeColor('#11223344')).toBe('#112233');
    expect(normalizeColor('#123456789')).toBe('#124578');
    expect(normalizeColor('#1234abcd5678')).toBe('#12ab56');
    expect(normalizeColor('a1b2c3')).toBe('#a1b2c3');
    expect(normalizeColor(' "pink" ')).toBe('#ffc0cb');
    expect(normalizeColor('Light Blue')).toBe('#add8e6');
    expect(normalizeColor('green')).toBe('#008000');
    expect(normalizeColor('GRAY')).toBe('#808080');
    expect(normalizeColor('rebeccapurple')).toBe('#663399');
  });

  it('rejects anything else', () => {
    for (const v of ['', 'notacolour', '#12', '#12345', '#ggg', 'constructor', '__proto__', 'toString', 'rgb(1,2,3)']) {
      expect(normalizeColor(v), v).toBeUndefined();
    }
  });
});

describe('sequence helpers', () => {
  it('cleans residues per molecule type', () => {
    expect(cleanResidues('acgu', 'DNA')).toEqual({ seq: 'ACGT', invalid: new Map(), firstInvalidIndex: -1 });
    expect(cleanResidues('acgu', 'RNA').seq).toBe('ACGU');
    expect(cleanResidues('mkv*', 'protein').seq).toBe('MKV*');
    const bad = cleanResidues('ac-Xé', 'DNA');
    expect(bad.seq).toBe('ACNNN');
    expect(bad.firstInvalidIndex).toBe(2);
    expect([...bad.invalid.keys()]).toEqual(['-', 'X', 'é']);
    expect(cleanResidues('mk-1', 'protein').seq).toBe('MKXX');
    const long = 'acgt'.repeat(10_000) + '?';
    expect(cleanResidues(long, 'DNA').seq).toBe('ACGT'.repeat(10_000) + 'N');
  });

  it('detects proteins and RNA', () => {
    expect(detectMolecule('ACGTN')).toBe('DNA');
    expect(detectMolecule('ACGUN')).toBe('RNA');
    expect(detectMolecule('ACGTU')).toBe('DNA');
    expect(detectMolecule('MKVLA')).toBe('protein');
    expect(detectMolecule('')).toBe('DNA');
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

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

describe('robustness: never throws, always returns valid records', () => {
  const sources = readdirSync(FIXTURES)
    .sort()
    .map((f) => fixture(f));

  function checkInvariants(text: string) {
    const r = parseGenbank(text);
    for (const rec of r.records) {
      const L = rec.seq.length;
      expect(rec.seq).toMatch(rec.molecule === 'protein' ? /^[A-Z*]*$/ : /^[ACGTURYSWKMBDHVN]*$/);
      for (const f of rec.features) {
        expect(f.segments.length).toBeGreaterThan(0);
        for (const s of f.segments) {
          expect(s.start).toBeGreaterThanOrEqual(0);
          expect(s.end).toBeGreaterThanOrEqual(s.start);
          if (rec.topology === 'linear') expect(s.end).toBeLessThanOrEqual(L);
          else expect(s.end - s.start).toBeLessThanOrEqual(L);
        }
        expect([1, -1, 0]).toContain(f.strand);
      }
      // anything we read can be written and read back
      expect(parseGenbank(writeGenbank(rec, { date: '01-JAN-2000' })).records).toHaveLength(1);
    }
    for (const w of r.warnings) {
      if (w.line !== undefined) expect(w.line).toBeGreaterThanOrEqual(1);
    }
  }

  it('survives 400 seeded random line-level mutations of the fixtures', () => {
    const next = rng(7);
    for (let iter = 0; iter < 400; iter++) {
      const lines = sources[Math.floor(next() * sources.length)].split('\n');
      const edits = 1 + Math.floor(next() * 6);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(next() * lines.length);
        const r = next();
        if (r < 0.3) lines.splice(at, 1);
        else if (r < 0.5) lines.splice(at, 0, lines[Math.floor(next() * lines.length)] ?? '');
        else if (r < 0.7) lines[at] = (lines[at] ?? '').slice(0, Math.floor(next() * 40));
        else if (r < 0.85) lines[at] = (lines[at] ?? '').replace(/"/g, '');
        else lines[at] = (lines[at] ?? '').replace(/\d/, '9999999');
      }
      checkInvariants(lines.join('\n'));
    }
  });

  it('survives random bytes and truncations', () => {
    const next = rng(11);
    const alphabet = 'LOCUS FEATURES ORIGIN //\n "/=()<>.,^0123456789acgtnACGT\t\r';
    for (let iter = 0; iter < 200; iter++) {
      let s = 'LOCUS       x 10 bp DNA\n';
      const n = Math.floor(next() * 400);
      for (let k = 0; k < n; k++) s += alphabet[Math.floor(next() * alphabet.length)];
      checkInvariants(s);
    }
    const pUC = fixture('pUC19_M77789.gb');
    for (let cut = 0; cut < pUC.length; cut += 97) checkInvariants(pUC.slice(0, cut));
  });
});
