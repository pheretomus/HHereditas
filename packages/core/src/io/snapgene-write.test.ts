/**
 * Tests of the (experimental) SnapGene writer: exact file layout against hand-written golden
 * packets modelled on files written by SnapGene, round trips through the reader, warnings for
 * what SnapGene cannot store, seeded property tests and fixture round trips.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFeature, makeRecord } from '../seq/features';
import type { Feature, SeqRecord } from '../types';
import { decodeUtf8, readPackets } from './snapgene-binary';
import { parseXml } from './snapgene-markup';
import { deterministicUuid, isStorableNotesName } from './snapgene-notes';
import { parseSnapGene, writeSnapGene, writeSnapGeneWithWarnings } from './snapgene';
import {
  FIXTURE_DIR,
  PMD19_LACZ,
  PMD20_LACZ,
  Rng,
  WRITER_DEFAULT_COLORS,
  WRITER_FALLBACK_COLOR,
  comparableRecord,
  expectedRoundTrip,
  libraryExcerptFile,
  randomRecord,
  recordProblems,
} from '../../test/oracle/snapgene/testkit';

const NOW = new Date(Date.UTC(2026, 9, 8, 7, 5, 3));

/** Writer warning for the reference summary that the reader keeps in meta.extras.References. */
const REFERENCES_NOT_WRITTEN = 'The references (meta.extras.References) were not written: only a text summary of them is kept, which a SnapGene file cannot store.';

function packetsOf(data: Uint8Array): Array<{ type: number; text: string; payload: Uint8Array }> {
  const scan = readPackets(data);
  expect(scan.warnings).toEqual([]);
  return scan.packets.map((p) => ({ type: p.type, text: decodeUtf8(p.payload), payload: p.payload }));
}

function roundTrip(record: SeqRecord, now = NOW): SeqRecord {
  const { data, warnings } = writeSnapGeneWithWarnings(record, { now });
  expect(warnings).toEqual([]);
  const result = parseSnapGene(data, { fileName: `${record.name}.dna` });
  expect(result.warnings).toEqual([]);
  expect(result.records).toHaveLength(1);
  expect(recordProblems(result.records[0])).toEqual([]);
  return result.records[0];
}

function writeWarnings(record: SeqRecord): string[] {
  return writeSnapGeneWithWarnings(record, { now: NOW }).warnings.map((w) => w.message);
}

const demo = (): SeqRecord =>
  makeRecord({
    name: 'demo',
    description: 'Demo plasmid & co',
    seq: 'ACGT'.repeat(25),
    topology: 'circular',
    features: [
      makeFeature({
        type: 'CDS',
        name: 'gene A',
        strand: -1,
        segments: [{ start: 90, end: 110 }],
        qualifiers: [
          { key: 'label', value: 'gene A' },
          { key: 'codon_start', value: '2' },
          { key: 'note', value: 'α & <β>' },
        ],
        color: '#ff0000',
      }),
    ],
    primers: [{ id: 'p1', name: 'fwd', sequence: 'ACGTACGTACGT', description: 'forward' }],
    meta: { organism: 'E. coli' },
  });

describe('writeSnapGene: file layout', () => {
  const data = writeSnapGene(demo(), { now: NOW });
  const packets = packetsOf(data);

  it('writes the packets in SnapGene order with a 15/19 DNA cookie', () => {
    expect(packets.map((p) => p.type)).toEqual([0x09, 0x00, 0x11, 0x08, 0x0a, 0x05, 0x06, 0x1c, 0x0e]);
    expect(Array.from(packets[0].payload)).toEqual([...'SnapGene'].map((c) => c.charCodeAt(0)).concat([0, 1, 0, 15, 0, 19]));
    expect(Array.from(data.subarray(0, 5))).toEqual([0x09, 0, 0, 0, 14]);
  });

  it('writes the flags byte and the bases', () => {
    expect(packets[1].payload[0]).toBe(0x03); // circular + double stranded
    expect(packets[1].text.slice(1)).toBe('ACGT'.repeat(25));
  });

  it('writes the constant packets of recent SnapGene versions', () => {
    expect(packets[2].text).toBe('<AlignableSequences trimStringency="Medium"/>');
    expect(packets[7].text).toBe('<?xml version="1.0"?><EnzymeVisibilities vals=""/>\n');
    expect(packets[8].text).toBe('<?xml version="1.0"?><CustomEnzymeSets/>\n');
  });

  it('writes the sequence properties', () => {
    expect(packets[3].text).toBe(
      '<AdditionalSequenceProperties><UpstreamStickiness>0</UpstreamStickiness><DownstreamStickiness>0</DownstreamStickiness>' +
        '<UpstreamModification>Unmodified</UpstreamModification><DownstreamModification>Unmodified</DownstreamModification></AdditionalSequenceProperties>',
    );
  });

  it('writes features with the attributes SnapGene uses', () => {
    expect(packets[4].text).toBe(
      '<?xml version="1.0"?><Features nextValidID="1">' +
        '<Feature recentID="0" name="gene A" directionality="2" type="CDS" swappedSegmentNumbering="1" allowSegmentOverlaps="0" readingFrame="-2" consecutiveTranslationNumbering="1">' +
        '<Segment range="91-10" color="#ff0000" type="standard" translated="1"/>' +
        '<Q name="label"><V text="gene A"/></Q><Q name="codon_start"><V int="2"/></Q><Q name="note"><V text="α &amp; &lt;β&gt;"/></Q>' +
        '</Feature></Features>\n',
    );
  });

  it('writes primers without binding sites', () => {
    expect(packets[5].text).toBe(
      '<?xml version="1.0"?><Primers nextValidID="1">' +
        '<HybridizationParams minContinuousMatchLen="10" allowMismatch="1" minMeltingTemperature="40" showAdditionalFivePrimeMatches="1" minimumFivePrimeAnnealing="15"/>' +
        '<Primer recentID="0" name="fwd" sequence="ACGTACGTACGT" description="forward" dateAdded="2026-10-08T07:05:03Z"/></Primers>\n',
    );
  });

  it('writes the notes with time stamps from `now` (UTC)', () => {
    const uuid = /<UUID>([^<]+)<\/UUID>/.exec(packets[6].text)?.[1] ?? '';
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(packets[6].text).toBe(
      '<Notes>\n' +
        `<UUID>${uuid}</UUID>\n` +
        '<Type>Synthetic</Type>\n' +
        '<ConfirmedExperimentally>0</ConfirmedExperimentally>\n' +
        '<Description>Demo plasmid &amp; co</Description>\n' +
        '<Created UTC="7:5:3">2026.10.8</Created>\n' +
        '<LastModified UTC="7:5:3">2026.10.8</LastModified>\n' +
        '<Organism>E. coli</Organism>\n' +
        '<SequenceClass>UNA</SequenceClass>\n' +
        '<TransformedInto>unspecified</TransformedInto>\n' +
        '</Notes>\n',
    );
  });

  it('is deterministic for a given `now`', () => {
    expect(writeSnapGene(demo(), { now: NOW })).toEqual(data);
    expect(writeSnapGene(demo(), { now: new Date(NOW.getTime() + 1000) })).not.toEqual(data);
    expect(deterministicUuid('x')).toBe(deterministicUuid('x'));
    expect(deterministicUuid('x')).not.toBe(deterministicUuid('y'));
  });

  it('uses the current time when `now` is not given', () => {
    const record = parseSnapGene(writeSnapGene(demo())).records[0];
    const today = new Date();
    expect(record.meta.extras?.LastModified).toBe(`${today.getUTCFullYear()}.${today.getUTCMonth() + 1}.${today.getUTCDate()}`);
  });

  it('hides source features, as SnapGene does on GenBank import', () => {
    const source = makeFeature({ type: 'source', name: 'source', segments: [{ start: 0, end: 10 }], color: '#ffffff', qualifiers: [{ key: 'organism', value: 'synthetic construct' }, { key: 'label', value: 'source' }] });
    const record = makeRecord({ name: 'src', seq: 'ACGTACGTAC', features: [source] });
    const xml = packetsOf(writeSnapGene(record, { now: NOW })).find((p) => p.type === 0x0a)?.text ?? '';
    expect(xml).toContain('<Feature recentID="0" name="source" type="source" allowSegmentOverlaps="0" consecutiveTranslationNumbering="1" visible="0">');
    expect(roundTrip(record).features[0].qualifiers).toEqual(source.qualifiers);
  });

  it('omits the features packet when there are no features', () => {
    const types = packetsOf(writeSnapGene(makeRecord({ seq: 'ACGT' }), { now: NOW })).map((p) => p.type);
    expect(types).toEqual([0x09, 0x00, 0x11, 0x08, 0x05, 0x06, 0x1c, 0x0e]);
  });

  it('rejects records it cannot write', () => {
    expect(() => writeSnapGene(makeRecord({ seq: 'MKV', molecule: 'protein' }))).toThrow(/only DNA records/);
    expect(() => writeSnapGene(makeRecord({ seq: 'ACGU', molecule: 'RNA' }))).toThrow(/only DNA records/);
    expect(() => writeSnapGene(makeRecord({ seq: 'ACGT' }), { now: new Date(Number.NaN) })).toThrow(RangeError);
  });

  it('does not modify the record', () => {
    const record = demo();
    const copy = structuredClone(record);
    writeSnapGeneWithWarnings(record, { now: NOW });
    expect(record).toEqual(copy);
  });

  it('accepts deeply frozen records', () => {
    const deepFreeze = <T>(value: T): T => {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
      }
      return value;
    };
    const rng = new Rng(99);
    for (let i = 0; i < 20; i++) {
      const record = randomRecord(rng, i);
      const expected = writeSnapGene(structuredClone(record), { now: NOW });
      expect(writeSnapGene(deepFreeze(record), { now: NOW })).toEqual(expected);
    }
  });
});

describe('writeSnapGene: round trips', () => {
  const linear = (features: Feature[], extra: Partial<SeqRecord> = {}) =>
    makeRecord({ name: 'rt', seq: 'GAATTCGGATCCAAGCTTCTGCAGGTCGACTCTAGAGCATGCCTGCAGGCATGCAAGCTT', features, ...extra });

  it('keeps origin-wrapping, multi-segment, reverse and coloured features', () => {
    const features = [
      makeFeature({ type: 'misc_feature', name: 'wraps', strand: 1, segments: [{ start: 50, end: 70 }], color: '#00ff00' }),
      makeFeature({ type: 'CDS', name: 'exons', strand: 1, segments: [{ start: 2, end: 10 }, { start: 15, end: 30 }, { start: 30, end: 33 }], color: '#993366' }),
      makeFeature({ type: 'CDS', name: 'reverse exons', strand: -1, segments: [{ start: 5, end: 12 }, { start: 20, end: 31 }], color: '#ccffcc' }),
      makeFeature({ type: 'gene', name: 'across origin', strand: -1, segments: [{ start: 55, end: 60 }, { start: 0, end: 8 }], color: '#ff7f50' }),
      makeFeature({ type: 'rep_origin', name: 'whole circle', strand: 0, segments: [{ start: 7, end: 67 }], color: '#ffff00' }),
      makeFeature({ type: 'misc_feature', name: 'circle from origin', strand: 0, segments: [{ start: 0, end: 60 }], color: '#a6acb3' }),
      makeFeature({ type: 'misc_feature', name: 'one base', strand: 1, segments: [{ start: 59, end: 60 }], color: '#a6acb3' }),
    ];
    const record = linear(features, { topology: 'circular' });
    const back = roundTrip(record);
    expect(back.features.map((f) => [f.name, f.strand, f.segments, f.color])).toEqual(features.map((f) => [f.name, f.strand, f.segments, f.color]));
    // Gaps are written between non-adjacent segments only.
    const xml = packetsOf(writeSnapGene(record, { now: NOW })).find((p) => p.type === 0x0a)?.text ?? '';
    expect(xml).toContain('<Segment range="3-10" color="#993366" type="standard" translated="1"/><Segment range="11-15" color="noColor" type="gap"/>');
    expect(xml).toContain('<Segment range="56-60" color="#ff7f50" type="standard"/><Segment range="1-8" color="#ff7f50" type="standard"/>');
    expect(xml).toContain('<Segment range="8-7" color="#ffff00" type="standard"/>');
  });

  it('handles length-1 sequences on both topologies and strands', () => {
    for (const topology of ['linear', 'circular'] as const) {
      for (const strand of [1, -1, 0] as const) {
        const record = makeRecord({
          name: 'one',
          seq: 'G',
          topology,
          features: [makeFeature({ type: 'misc_feature', name: 'the base', strand, segments: [{ start: 0, end: 1 }], color: '#a6acb3' })],
        });
        const xml = packetsOf(writeSnapGene(record, { now: NOW })).find((p) => p.type === 0x0a)?.text ?? '';
        expect(xml).toContain('<Segment range="1-1" color="#a6acb3" type="standard"/>');
        const back = roundTrip(record);
        expect(back.seq).toBe('G');
        expect(back.features.map((f) => [f.strand, f.segments])).toEqual([[strand, [{ start: 0, end: 1 }]]]);
      }
    }
  });

  it('keeps qualifiers with special characters and every value form', () => {
    const qualifiers = [
      { key: 'label', value: 'specials' },
      { key: 'note', value: `& < > " ' α µ 🧬 &amp; &#10; <5kb>` },
      { key: 'note', value: 'looks like <b>HTML</b> & stays text' },
      { key: 'product', value: 'β-lactamase' },
      { key: 'db_xref', value: 'GI:238030067' },
      { key: 'codon_start', value: '3' },
      { key: 'transl_table', value: '11' },
      { key: 'number', value: '007' },
      { key: 'pseudo', value: null },
      { key: 'experiment', value: '' },
    ];
    const record = linear([makeFeature({ type: 'CDS', name: 'specials', strand: 1, segments: [{ start: 0, end: 30 }], qualifiers, color: '#993366' })]);
    expect(roundTrip(record).features[0].qualifiers).toEqual(qualifiers);
  });

  it('keeps names and descriptions that look like markup', () => {
    const record = linear([makeFeature({ type: 'misc_feature', name: '<i>lacZ</i> α', segments: [{ start: 0, end: 5 }], color: '#a6acb3' })], {
      description: 'pUC19 <b>derivative</b> & friends',
    });
    const back = roundTrip(record);
    expect(back.description).toBe('pUC19 <b>derivative</b> & friends');
    expect(back.features[0].name).toBe('<i>lacZ</i> α');
  });

  it('keeps segment names that look like markup (verification defect: written raw, read back as HTML)', () => {
    // Segment names (Biopython-style /parts) are rich text for the reader, like every other name.
    // Before the fix "<b>signal</b>" read back as "signal", "x<br>y" as "x y" and "<html>" vanished.
    for (const name of ['<b>signal</b> peptide', 'x<br>y', '<html>', 'exon <!-- 2 --> b', '<p>intron</p>', 'a & b <5kb>']) {
      const parts = { key: 'parts', value: `2:${name}` };
      const record = linear([
        makeFeature({ type: 'CDS', name: 'split', strand: -1, segments: [{ start: 2, end: 10 }, { start: 15, end: 30 }], qualifiers: [parts, { key: 'label', value: 'split' }], color: '#993366' }),
      ]);
      const xml = packetsOf(writeSnapGene(record, { now: NOW })).find((p) => p.type === 0x0a)?.text ?? '';
      expect(xml, name).toMatch(/<Segment name="[^"]*" range="3-10"/); // reverse feature: segment 2 counted 5'->3' is the left one
      expect(roundTrip(record).features[0].qualifiers, name).toEqual([parts, { key: 'label', value: 'split' }]);
    }
  });

  it('keeps primers, comments, accession and organism', () => {
    const record = linear([], {
      primers: [
        { id: 'a', name: 'M13 fwd', sequence: 'GTAAAACGACGGCCAGT', description: 'universal & cheap' },
        { id: 'b', name: '<b>rev</b>', sequence: 'CAGGAAACAGCTATGACNNRY' },
      ],
      meta: { accession: 'L09137', organism: 'synthetic construct', comments: ['first line\nsecond <line> & more'] },
    });
    const back = roundTrip(record);
    expect(back.primers.map(({ id, ...p }) => p)).toEqual(record.primers.map(({ id, ...p }) => p));
    expect(back.meta).toMatchObject({ accession: 'L09137', organism: 'synthetic construct', comments: ['first line\nsecond <line> & more'] });
  });

  it('keeps sticky ends of every kind', () => {
    for (const [left, right] of [
      [{ kind: '5prime', length: 4 }, { kind: '5prime', length: 4 }],
      [{ kind: '3prime', length: 1 }, { kind: '3prime', length: 1 }],
      [{ kind: 'blunt', length: 0 }, { kind: '5prime', length: 4 }],
      [{ kind: '3prime', length: 3 }, { kind: 'blunt', length: 0 }],
    ] as const) {
      const record = linear([], { ends: { left: { ...left }, right: { ...right } } });
      expect(roundTrip(record).ends).toEqual({ left, right });
      const props = packetsOf(writeSnapGene(record, { now: NOW })).find((p) => p.type === 0x08)?.text ?? '';
      const signed = (end: { kind: string; length: number }) => (end.kind === '3prime' ? -end.length : end.length);
      expect(props).toContain(`<UpstreamStickiness>${signed(left)}</UpstreamStickiness><DownstreamStickiness>${signed(right)}</DownstreamStickiness>`);
    }
  });

  it('keeps strandedness, methylation and end modifications from meta.extras', () => {
    const extras = {
      Strandedness: 'single',
      DamMethylated: '1',
      DcmMethylated: '0',
      EcoKIMethylated: '1',
      UpstreamModification: 'FivePrimePhosphorylated',
      DownstreamModification: 'Unmodified',
    };
    const record = linear([], { meta: { extras } });
    const data = writeSnapGene(record, { now: NOW });
    expect(packetsOf(data)[1].payload[0]).toBe(0x14);
    expect(roundTrip(record).meta.extras).toMatchObject(extras);
  });

  it('gives colourless features SnapGene default colours and unnamed features a derived name', () => {
    const record = linear([
      makeFeature({ type: 'CDS', name: 'c', segments: [{ start: 0, end: 3 }] }),
      makeFeature({ type: 'promoter', name: 'p', segments: [{ start: 0, end: 3 }] }),
      makeFeature({ type: 'rep_origin', name: 'o', segments: [{ start: 0, end: 3 }] }),
      makeFeature({ type: 'protein_bind', name: 'b', segments: [{ start: 0, end: 3 }] }),
      { ...makeFeature({ type: 'gene', segments: [{ start: 0, end: 3 }], qualifiers: [{ key: 'gene', value: 'lacZ' }] }), name: '' },
    ]);
    const back = roundTrip(record);
    expect(back.features.map((f) => f.color)).toEqual([WRITER_DEFAULT_COLORS.CDS, WRITER_DEFAULT_COLORS.promoter, WRITER_DEFAULT_COLORS.rep_origin, WRITER_FALLBACK_COLOR, WRITER_FALLBACK_COLOR]);
    expect(WRITER_DEFAULT_COLORS).toEqual({ CDS: '#993366', promoter: '#ffffff', terminator: '#ffffff', rep_origin: '#ffff00' });
    expect(back.features[4].name).toBe('lacZ');
  });

  it('handles feature types and qualifier keys that are JavaScript property names', () => {
    const tricky = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
    const record = linear(tricky.map((type) => makeFeature({ type, name: type, segments: [{ start: 0, end: 4 }], qualifiers: [{ key: type, value: type }, { key: 'label', value: type }] })));
    const back = roundTrip(record);
    expect(back.features.map((f) => [f.type, f.color, f.qualifiers[0]])).toEqual(tricky.map((type) => [type, WRITER_FALLBACK_COLOR, { key: type, value: type }]));
  });

  it('keeps the SnapGene fields of a record read from a SnapGene file', () => {
    const original = parseSnapGene(new Uint8Array(readFileSync(join(FIXTURE_DIR, 'pFA-KanMX4.dna')))).records[0];
    const { data, warnings } = writeSnapGeneWithWarnings(original, { now: NOW });
    expect(warnings.map((w) => w.message)).toEqual([REFERENCES_NOT_WRITTEN]);
    const back = parseSnapGene(data, { fileName: 'pFA-KanMX4.dna' });
    expect(back.warnings).toEqual([]);
    const extras = back.records[0].meta.extras ?? {};
    expect(extras).toMatchObject({
      UUID: '4bdbcd8e-3a32-4599-8c39-f269dcd552dc',
      Created: '2012.5.26',
      CustomMapLabel: 'pFA6-kanMX4',
      UseCustomMapLabel: '1',
      ConfirmedExperimentally: '0',
      LastModified: '2026.10.8',
      'LastModified.UTC': '7:5:3',
    });
    expect(extras['Created.UTC']).toBeUndefined(); // the original Created had no UTC attribute
  });
});

describe('writeSnapGene: warnings for what SnapGene cannot store', () => {
  const base = (patch: Partial<SeqRecord>) => makeRecord({ name: 'w', seq: 'ACGTACGTAC', ...patch });
  const f = (segments: Array<{ start: number; end: number }>, extra: Partial<Feature> = {}) => ({
    ...makeFeature({ type: 'misc_feature', name: 'x', segments, color: '#a6acb3' }),
    ...extra,
  });

  it('drops invalid and empty segments, and features left without segments', () => {
    expect(writeWarnings(base({ features: [f([{ start: 2, end: 2 }])] }))).toEqual([
      'Feature "x": segment 2^3 is empty and cannot be stored in a SnapGene file; not written.',
      'Feature "x" has no segment that can be written; feature not written.',
    ]);
    expect(writeWarnings(base({ features: [f([{ start: 5, end: 12 }, { start: 0, end: 2 }])] }))).toEqual([
      'Feature "x": segment 6..12 extends beyond the 10 bp sequence; not written.',
    ]);
    expect(writeWarnings(base({ features: [f([{ start: 0.5, end: 2 }, { start: 1, end: 2 }])] }))[0]).toBe('Feature "x": segment 1.5..2 has non-integer coordinates; not written.');
    expect(writeWarnings(base({ topology: 'circular', features: [f([{ start: 12, end: 15 }])] }))).toEqual([
      'Feature "x": segment 13..15 starts outside 1..10; written as 3..5.',
    ]);
    const parsed = parseSnapGene(writeSnapGene(base({ topology: 'circular', features: [f([{ start: 12, end: 15 }])] }), { now: NOW })).records[0];
    expect(parsed.features[0].segments).toEqual([{ start: 2, end: 5 }]);
  });

  it('gives positions 1-based in warnings, with the actual reason (reviewed defect: 0-based "a..b", reversed segments called "outside")', () => {
    const hundred = (topology: 'linear' | 'circular', segments: Array<{ start: number; end: number }>) =>
      writeWarnings(makeRecord({ name: 'w', seq: 'ACGT'.repeat(25), topology, features: [f(segments)] }));
    // The file stores SnapGene range "91-10": bases 91-100 and 1-10.
    expect(hundred('circular', [{ start: -10, end: 10 }])).toEqual(['Feature "x": segment -9..10 starts outside 1..100; written as 91..10.']);
    expect(hundred('linear', [{ start: 50, end: 40 }])[0]).toBe('Feature "x": segment 51..40 ends before it starts; not written.');
    expect(hundred('circular', [{ start: 50, end: 40 }])).toEqual(['Feature "x": segment 51..40 ends before it starts, so it was taken to run through the origin; written as 51..40.']);
    expect(hundred('circular', [{ start: 5, end: 125 }])).toEqual(['Feature "x": segment 6..125 is longer than the 100 bp circular sequence; written as 6..5.']);
    expect(hundred('circular', [{ start: 0, end: 0 }])[0]).toBe('Feature "x": segment 100^1 is empty and cannot be stored in a SnapGene file; not written.');
    expect(hundred('circular', [{ start: 130, end: 130 }])[0]).toBe('Feature "x": segment 30^31 is empty and cannot be stored in a SnapGene file; not written.');
    expect(hundred('circular', [{ start: 5, end: -95 }])[0]).toBe(
      'Feature "x": segment 6..-95 ends a whole number of turns of the 100 bp circular sequence before it starts, so it is empty; not written.',
    );
    expect(hundred('linear', [{ start: -3, end: 4 }])[0]).toBe('Feature "x": segment -2..4 extends beyond the 100 bp sequence; not written.');
    // What was written is what the warning says.
    const record = makeRecord({ name: 'w', seq: 'ACGT'.repeat(25), topology: 'circular', features: [f([{ start: -10, end: 10 }])] });
    expect(packetsOf(writeSnapGene(record, { now: NOW })).find((p) => p.type === 0x0a)?.text).toContain('<Segment range="91-10"');
  });

  it('reports segments it cannot order', () => {
    const warnings = writeWarnings(base({ features: [f([{ start: 6, end: 8 }, { start: 1, end: 3 }])] }));
    expect(warnings).toEqual(['Feature "x": segments are not in ascending order, which SnapGene cannot represent faithfully.']);
    const xml = packetsOf(writeSnapGene(base({ features: [f([{ start: 6, end: 8 }, { start: 1, end: 3 }])] }), { now: NOW })).find((p) => p.type === 0x0a)?.text ?? '';
    expect(xml).toContain('allowSegmentOverlaps="1"');
    expect(parseSnapGene(writeSnapGene(base({ features: [f([{ start: 6, end: 8 }, { start: 1, end: 3 }])] }))).records[0].features[0].segments).toEqual([
      { start: 6, end: 8 },
      { start: 1, end: 3 },
    ]);
  });

  it('reports sticky ends it cannot write', () => {
    expect(writeWarnings(base({ topology: 'circular', ends: { left: { kind: '5prime', length: 2 }, right: { kind: 'blunt', length: 0 } } }))).toEqual([
      'The record is circular, so its sticky ends were not written (SnapGene stores ends for linear sequences only).',
    ]);
    expect(writeWarnings(base({ ends: { left: { kind: '5prime', length: 6 }, right: { kind: '3prime', length: 4 } } }))).toEqual([
      'The sticky ends (6 + 4 nt) cover the whole 10 bp sequence; they were written as blunt.',
    ]);
    expect(writeWarnings(base({ ends: { left: { kind: 'blunt', length: 3 }, right: { kind: 'blunt', length: 0 } } }))).toEqual([
      'The record has malformed sticky ends; they were written as blunt.',
    ]);
  });

  it('reports bases, characters and primers it had to change', () => {
    expect(writeWarnings(base({ seq: 'ACGT-*xu' }))).toEqual([
      // lower-case 'u' is a valid base (upper-cased, U -> T); '-', '*' and 'x' are not
      'The sequence contains 3 character(s) that are not IUPAC nucleotide codes ("-", "*", "x"); they were written as \'N\'.',
    ]);
    expect(parseSnapGene(writeSnapGene(base({ seq: 'ACGT-*xu' }))).records[0].seq).toBe('ACGTNNNT');
    expect(writeWarnings(base({ description: 'bell\u0007 here' }))).toEqual(['1 control character(s) that XML cannot represent were written as U+FFFD.']);
    expect(writeWarnings(base({ primers: [{ id: 'p', name: 'bad', sequence: 'ACG-T 5x' }, { id: 'q', name: '', sequence: '' }] }))).toEqual([
      'Primer "bad": characters that are not nucleotide codes were not written ("-", "5", "x").',
      'Primer "Primer 2" has no sequence; not written.',
    ]);
  });

  it('reports fuzzy ends, invalid colours and mixed value-less qualifiers', () => {
    expect(
      writeWarnings(
        base({
          features: [
            f([{ start: 0, end: 3 }], { partialStart: true, color: 'red', qualifiers: [{ key: 'pseudo', value: null }, { key: 'pseudo', value: 'x' }, { key: ' ', value: 'y' }] }),
          ],
        }),
      ),
    ).toEqual([
      'Feature "x": colour "red" is not \'#rrggbb\'; the default colour was written.',
      'Feature "x": qualifier with an empty name; not written.',
      'Feature "x": value-less /pseudo not written because /pseudo also has values.',
      '1 feature(s) have partial (fuzzy) ends, which SnapGene files cannot store; they were written with exact ends.',
    ]);
  });
});

describe('writeSnapGene: metadata it cannot store is reported, the rest survives (reviewed defects)', () => {
  const messages = (record: SeqRecord) => writeSnapGeneWithWarnings(record, { now: NOW }).warnings.map((w) => w.message);
  const readBack = (record: SeqRecord) => {
    const result = parseSnapGene(writeSnapGene(record, { now: NOW }), { fileName: 'meta.dna' });
    expect(result.warnings).toEqual([]);
    return result.records[0];
  };

  it('skips Notes fields whose names the XML parser rejects or renames, instead of losing the whole Notes packet', () => {
    // fast-xml-parser rejects a document with an element named "constructor" (all Notes fields were lost on reading).
    const record = makeRecord({ seq: 'ACGTACGTAC', description: 'my plasmid', meta: { sourceFormat: 'snapgene', organism: 'E. coli', accession: 'X1', extras: { constructor: 'J. Doe' } } });
    expect(messages(record)).toEqual(['1 SnapGene Notes field(s) of meta.extras were not written because a SnapGene file cannot store their names: "constructor".']);
    const back = readBack(record);
    expect(back).toMatchObject({ description: 'my plasmid', meta: { organism: 'E. coli', accession: 'X1' } });
    // Every name the parser alters, as element and as attribute; storable fields next to them survive.
    const extras: Record<string, string> = JSON.parse(
      '{"__proto__":"a","prototype":"b","toString":"c","valueOf":"d","hasOwnProperty":"e","__defineGetter__":"f","__lookupSetter__":"g",' +
        '"Field":"kept","Field.toString":"h","Field.unit":"mg","xmlField":"i","two words":"j"}',
    ) as Record<string, string>;
    const tricky = makeRecord({ seq: 'ACGTACGTAC', description: 'still here', meta: { sourceFormat: 'snapgene', extras } });
    expect(messages(tricky)).toEqual([
      '10 SnapGene Notes field(s) of meta.extras were not written because a SnapGene file cannot store their names: "__proto__", "prototype", "toString", "valueOf", "hasOwnProperty" and 5 more.',
    ]);
    const trickyBack = readBack(tricky);
    expect(trickyBack.description).toBe('still here');
    expect(trickyBack.meta.extras).toMatchObject({ Field: 'kept', 'Field.unit': 'mg' });
    expect(Object.keys(trickyBack.meta.extras ?? {}).filter((k) => !k.startsWith('Field') && /^[a-z_]/.test(k))).toEqual([]);
  });

  it('knows exactly which element and attribute names the XML parser does not read back (checked against fast-xml-parser)', () => {
    const candidates = new Set<string>(['__proto__', 'constructor', 'prototype', 'Field', 'a-b', '_x', 'Created', 'UTC', 'x1']);
    for (const prototype of [Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype, Promise.prototype]) {
      for (const name of Object.getOwnPropertyNames(prototype)) candidates.add(name);
    }
    let checked = 0;
    for (const name of candidates) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || /^xml/i.test(name)) continue; // not a name the writer would try
      const element = parseXml(`<Notes><${name}>v</${name}></Notes>`);
      const attribute = parseXml(`<Notes><E ${name}="v"/></Notes>`);
      const readsBack =
        element.ok && element.root.children[0]?.name === name && attribute.ok && attribute.root.children[0]?.attributes.get(name) === 'v' && attribute.root.children[0].attributes.size === 1;
      expect(isStorableNotesName(name), name).toBe(readsBack);
      checked++;
    }
    expect(checked).toBeGreaterThan(80);
    expect(isStorableNotesName('xmlField')).toBe(false); // reserved by XML 1.0, although this parser reads it
  });

  it('reports reverse-strand colours, which SnapGene cannot store', () => {
    const feature = (name: string, extra: Partial<Feature>) => ({ ...makeFeature({ type: 'CDS', name, strand: -1, segments: [{ start: 0, end: 9 }] }), ...extra });
    const record = makeRecord({
      seq: 'ACGTACGTAC',
      features: [
        feature('differs', { color: '#ff0000', reverseColor: '#00ff00' }),
        feature('same', { color: '#ff0000', reverseColor: '#FF0000' }),
        feature('default', { reverseColor: '#993366' }), // equals the CDS colour written for colourless features
        feature('invalid', { color: '#ff0000', reverseColor: 'green' }),
      ],
    });
    expect(messages(record)).toEqual(['2 feature(s) have a reverse colour (a separate colour for the reverse strand), which SnapGene files cannot store; only the forward colour was written.']);
    expect(readBack(record).features.map((f) => [f.color, f.reverseColor])).toEqual([['#ff0000', undefined], ['#ff0000', undefined], ['#993366', undefined], ['#ff0000', undefined]]);
  });

  it('reports the GenBank header fields and meta.extras fields it drops', () => {
    const record = makeRecord({
      seq: 'ACGTACGTAC',
      meta: {
        accession: 'M77789',
        version: 'M77789.2',
        keywords: 'cloning vector',
        source: 'Cloning vector pUC19',
        organism: 'Cloning vector pUC19',
        division: 'SYN',
        comments: ['first', 'second'],
        extraHeaderLines: ['REFERENCE   1  (bases 1 to 2686)', '  AUTHORS   Yanisch-Perron,C., Vieira,J. and Messing,J.', '', 'DBLINK      BioProject: PRJNA1', 'REFERENCE   2'],
        sourceFormat: 'genbank',
        extras: { 'genbank.moleculeType': 'DNA', 'genbank.taxonomy': 'other sequences; artificial sequences; vectors.', Strandedness: 'double' },
      },
    });
    expect(messages(record)).toEqual([
      'The sequence version "M77789.2" (GenBank VERSION) was not written: SnapGene files have no field for it.',
      'The keywords "cloning vector" (GenBank KEYWORDS) were not written: SnapGene files have no field for them.',
      'The source "Cloning vector pUC19" (GenBank SOURCE) was not written: SnapGene files store only the organism.',
      '4 GenBank header line(s) ("REFERENCE", "DBLINK") were not written: SnapGene files cannot store them.',
      '2 field(s) of meta.extras were not written to the SnapGene file: "genbank.moleculeType", "genbank.taxonomy".',
    ]);
    const back = readBack(record);
    expect(back.meta).toMatchObject({ accession: 'M77789', organism: 'Cloning vector pUC19', division: 'SYN', comments: ['first\nsecond'] });
    expect([back.meta.version, back.meta.keywords, back.meta.source, back.meta.extraHeaderLines]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('reports meta.extras fields of a SnapGene record that have no place, and malformed SnapGene fields', () => {
    const record = makeRecord({
      seq: 'ACGTACGTAC',
      meta: {
        sourceFormat: 'snapgene',
        extras: { UUID: 'not-a-uuid', Created: '8 Oct 2026', 'Created.UTC': 'noon', Description: 'in extras', 'Type.kind': 'x', 'Lone.attr': 'y', Kept: 'z', 'Kept.unit': 'u' },
      },
    });
    expect(messages(record)).toEqual([
      'The SnapGene field UUID "not-a-uuid" (meta.extras) is malformed; a new UUID was written.',
      'The SnapGene field Created "8 Oct 2026" (meta.extras) is malformed; the current date was written.',
      'The SnapGene field Created.UTC "noon" (meta.extras) is malformed; the current time was written.',
      '3 field(s) of meta.extras were not written to the SnapGene file: "Description", "Type.kind", "Lone.attr".',
    ]);
    expect(readBack(record).meta.extras).toMatchObject({ Kept: 'z', 'Kept.unit': 'u', Created: '2026.10.8', 'Created.UTC': '7:5:3' });
    // A valid Created keeps its date; a malformed time of day is then left out.
    const timeOnly = makeRecord({ seq: 'ACGTACGTAC', meta: { sourceFormat: 'snapgene', extras: { Created: '2019.8.3', 'Created.UTC': '25 h' } } });
    expect(messages(timeOnly)).toEqual(['The SnapGene field Created.UTC "25 h" (meta.extras) is malformed; it was not written.']);
    const timeOnlyBack = readBack(timeOnly).meta.extras ?? {};
    expect([timeOnlyBack.Created, timeOnlyBack['Created.UTC']]).toEqual(['2019.8.3', undefined]);
  });

  it('writes an edited meta.division instead of the Type / SequenceClass kept from the SnapGene file', () => {
    const snapgene = (division: string | undefined, Type: string, SequenceClass: string) =>
      makeRecord({ seq: 'ACGTACGTAC', meta: { sourceFormat: 'snapgene', ...(division !== undefined ? { division } : {}), extras: { Type, SequenceClass } } });
    expect(readBack(snapgene('BCT', 'Synthetic', 'UNA')).meta).toMatchObject({ division: 'BCT', extras: { Type: 'Natural', SequenceClass: 'BCT' } });
    expect(readBack(snapgene('SYN', 'Natural', 'PHG')).meta).toMatchObject({ division: 'SYN', extras: { Type: 'Synthetic', SequenceClass: 'PHG' } });
    expect(readBack(snapgene('phg', 'Natural', 'UNA')).meta.division).toBe('PHG');
    expect(readBack(snapgene(undefined, 'Natural', 'PLN')).meta.division).toBe('PLN'); // no division: the SnapGene fields stay
    const odd = snapgene('XY', 'Natural', 'UNA');
    expect(messages(odd)).toEqual(['The division "XY" is not a three-letter GenBank division code, so it was not written.']);
    expect(readBack(odd).meta.division).toBe('UNA');
  });
});

describe('writeSnapGene: text whose line breaks or spacing do not read back is reported (verification defect: silent before)', () => {
  const SPACING = ' text value(s) lose line breaks or spacing in the SnapGene file: line breaks in one-line fields become spaces, and in text stored as HTML (multi-line comments, text that looks like markup) runs of spaces, tabs or non-breaking spaces become one space';
  const write = (record: SeqRecord) => {
    const { data, warnings } = writeSnapGeneWithWarnings(record, { now: NOW });
    const result = parseSnapGene(data, { fileName: 'text.dna' });
    expect(result.warnings).toEqual([]);
    return { messages: warnings.map((w) => w.message), back: result.records[0] };
  };
  const feature = (name: string, qualifiers: Feature['qualifiers']) =>
    makeFeature({ type: 'misc_feature', name, strand: 1, segments: [{ start: 0, end: 6 }], qualifiers: [{ key: 'label', value: name }, ...qualifiers], color: '#a6acb3' });

  it('lists every field that changes, in one warning, and changes nothing else', () => {
    const record = makeRecord({
      name: 'text',
      seq: 'ACGTACGTACGT',
      description: 'line one\nline two',
      features: [feature('f', [{ key: 'note', value: 'PCR:\n95 °C 30 s\n55 °C 30 s' }, { key: 'note', value: '<i>lacZ</i>  α' }, { key: 'note', value: 'kept  as  is' }])],
      primers: [{ id: 'p', name: 'fwd', sequence: 'ACGTACGT', description: 'Tm\n60' }],
      // GenBank structured comment: the alignment of the "::" column is lost in SnapGene's HTML.
      meta: { organism: 'E. coli', comments: ['##Assembly-Data-START##\nAssembly Method       :: SPAdes v. 3.15\nSequencing Technology :: Illumina'] },
    });
    const { messages, back } = write(record);
    expect(messages).toEqual([
      `5${SPACING} (Feature "f" /note, Primer "fwd" description, the description, the comments).`,
    ]);
    expect(back.description).toBe('line one line two');
    expect(back.features[0].qualifiers.filter((q) => q.key === 'note').map((q) => q.value)).toEqual(['PCR: 95 °C 30 s 55 °C 30 s', '<i>lacZ</i> α', 'kept  as  is']);
    expect(back.primers[0].description).toBe('Tm 60');
    expect(back.meta.comments).toEqual(['##Assembly-Data-START##\nAssembly Method :: SPAdes v. 3.15\nSequencing Technology :: Illumina']);
  });

  it('stays silent when the text reads back as written (plain spacing, single-line and multi-line text, CR LF, blanks at the ends)', () => {
    const record = makeRecord({
      name: 'text',
      seq: 'ACGTACGTACGT',
      description: '  pUC19  derivative  ',
      features: [feature('<b>bold</b> name', [{ key: 'note', value: 'a\tb  c' }, { key: 'note', value: 'x<br>y' }, { key: 'parts', value: '1:<i>exon</i> one' }])],
      primers: [{ id: 'p', name: ' rev ', sequence: 'ACGTACGT', description: 'plain  double  spaces' }],
      meta: { organism: 'E. coli K-12', comments: ['first\r\nsecond', 'third, joined to the others'] },
    });
    const { messages, back } = write(record);
    expect(messages).toEqual([]);
    expect(back.description).toBe('pUC19  derivative');
    expect(back.meta.comments).toEqual(['first\nsecond\nthird, joined to the others']);
    expect(back.features[0].qualifiers.filter((q) => q.key === 'note').map((q) => q.value)).toEqual(['a\tb  c', 'x<br>y']);
  });

  it('reports long lists briefly, counting every value', () => {
    const qualifiers = Array.from({ length: 7 }, (_, i) => ({ key: `note${i}`, value: `a\nb${i}` }));
    const { messages } = write(makeRecord({ name: 'text', seq: 'ACGTACGTACGT', features: [feature('g', qualifiers)] }));
    expect(messages).toEqual([
      `7${SPACING} (Feature "g" /note0, Feature "g" /note1, Feature "g" /note2, Feature "g" /note3, Feature "g" /note4 and 2 more).`,
    ]);
  });
});

describe('writeSnapGene: reading frames', () => {
  const featuresXml = (record: SeqRecord) => packetsOf(writeSnapGene(record, { now: NOW })).find((p) => p.type === 0x0a)?.text ?? '';

  it('keeps SnapGene\'s reading frame of CDSs read with a stale /codon_start (T-Vector pMD20 / pMD19 lacZα)', () => {
    for (const [excerpt, attribute] of [
      [PMD20_LACZ, 'readingFrame="2"'],
      [PMD19_LACZ, 'readingFrame="-2"'],
    ] as const) {
      const read = parseSnapGene(libraryExcerptFile(excerpt), { fileName: 'library.dna' }).records[0];
      const xml = featuresXml(read);
      expect(xml).toContain(attribute);
      expect(xml).toContain('<Q name="codon_start"><V int="2"/></Q>');
      const back = roundTrip(read);
      expect(back.features[0].qualifiers).toEqual(read.features[0].qualifiers);
    }
  });

  it('writes readingFrame from /codon_start and reports values that would read back differently', () => {
    const cds = (name: string, strand: 1 | -1 | 0, values: Array<string | null>) =>
      makeFeature({ type: 'CDS', name, strand, segments: [{ start: 0, end: 30 }], qualifiers: [{ key: 'label', value: name }, ...values.map((value) => ({ key: 'codon_start', value }))], color: '#993366' });
    const record = makeRecord({
      name: 'frames',
      seq: 'ACGT'.repeat(10),
      features: [
        cds('rev 3', -1, ['3']),
        cds('rev none', -1, []),
        cds('fwd 1', 1, ['1']),
        cds('fwd leading zero', 1, ['02']),
        cds('non-directional 2', 0, ['2']),
        cds('fwd junk', 1, ['5']), // forward frame 1: SnapGene writes no readingFrame, so the value survives
        cds('rev junk', -1, ['5']),
        cds('fwd two values', 1, ['2', '3']),
        cds('rev value-less', -1, [null]),
      ],
    });
    const xml = featuresXml(record);
    const frameOf = (name: string) => new RegExp(`<Feature [^>]*name="${name}"[^>]*>`).exec(xml)?.[0].match(/readingFrame="([^"]*)"/)?.[1];
    expect(['rev 3', 'rev none', 'fwd 1', 'fwd leading zero', 'non-directional 2', 'fwd junk', 'rev junk', 'fwd two values', 'rev value-less'].map(frameOf)).toEqual([
      '-3', '-1', undefined, '2', undefined, undefined, '-1', '2', '-1',
    ]);
    expect(writeWarnings(record)).toEqual([
      'Feature "rev junk": /codon_start=5 does not give one reading frame (1, 2 or 3); readingFrame="-1" was written, so the file reads back with /codon_start=1.',
      'Feature "fwd two values": /codon_start values 2, 3 do not give one reading frame (1, 2 or 3); readingFrame="2" was written, so the file reads back with /codon_start=2.',
      'Feature "rev value-less": /codon_start without a value does not give one reading frame (1, 2 or 3); readingFrame="-1" was written, so the file reads back with /codon_start=1.',
    ]);
    const back = parseSnapGene(writeSnapGene(record, { now: NOW })).records[0];
    const codonStarts = back.features.map((f) => f.qualifiers.filter((q) => q.key === 'codon_start').map((q) => q.value));
    expect(codonStarts).toEqual([['3'], [], ['1'], ['02'], ['2'], ['5'], ['1'], ['2'], ['1']]);
  });
});

describe('writeSnapGene: properties (seeded random records)', () => {
  it('round-trips 300 random records exactly (up to the documented normalisations)', () => {
    const rng = new Rng(20261008);
    for (let i = 0; i < 300; i++) {
      const record = randomRecord(rng, i);
      const now = new Date(Date.UTC(2020 + (i % 7), i % 12, 1 + (i % 28), i % 24, i % 60, (i * 7) % 60));
      const { data, warnings } = writeSnapGeneWithWarnings(record, { now });
      expect(warnings, `record ${i}`).toEqual([]);
      const result = parseSnapGene(data, { fileName: `${record.name}.dna` });
      expect(result.warnings, `record ${i}`).toEqual([]);
      const back = result.records[0];
      expect(recordProblems(back), `record ${i}`).toEqual([]);
      expect(comparableRecord(back), `record ${i}`).toEqual(expectedRoundTrip(record, now, back.meta.extras?.UUID ?? ''));
      // A second write of what was read gives the same bytes (the format is a fixed point).
      expect(writeSnapGene(back, { now }), `record ${i}`).toEqual(data);
    }
  });
});

describe('writeSnapGene: fixtures survive parse -> write -> parse', () => {
  const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.dna'));
  for (const name of names) {
    it(name, () => {
      const first = parseSnapGene(new Uint8Array(readFileSync(join(FIXTURE_DIR, name))), { fileName: name }).records[0];
      const { data, warnings } = writeSnapGeneWithWarnings(first, { now: NOW });
      // The only thing a fixture loses is the reference list of pFA-KanMX4.dna (kept only as a summary).
      expect(warnings.map((w) => w.message)).toEqual(first.meta.extras?.References !== undefined ? [REFERENCES_NOT_WRITTEN] : []);
      const second = parseSnapGene(data, { fileName: name });
      expect(second.warnings).toEqual([]);
      const expected = comparableRecord(first) as { meta: SeqRecord['meta'] };
      const { References, ...extras } = first.meta.extras ?? {};
      expect(References === undefined || name === 'pFA-KanMX4.dna').toBe(true); // References are summarised, not written back
      expected.meta = {
        ...first.meta,
        date: '08-OCT-2026',
        extras: { ...extras, LastModified: '2026.10.8', 'LastModified.UTC': '7:5:3' },
      };
      expect(comparableRecord(second.records[0])).toEqual(expected);
    });
  }
});

describe('writeSnapGene: scale', () => {
  it('writes and reads an E. coli-sized record (4.6 Mb, 4500 features) quickly and exactly', () => {
    const rng = new Rng(7);
    const L = 4_641_652;
    let seq = '';
    const chunk: string[] = [];
    for (let i = 0; i < L; i++) chunk.push('ACGT'[rng.int(0, 3)]);
    seq = chunk.join('');
    const features: Feature[] = [];
    for (let k = 0; k < 4500; k++) {
      const start = rng.int(0, L - 3000);
      const segments = rng.chance(0.1)
        ? [{ start, end: start + 300 }, { start: start + 400, end: start + 900 }]
        : [{ start, end: start + rng.int(30, 3000) }];
      features.push(makeFeature({ type: rng.pick(['CDS', 'gene', 'misc_feature']), name: `b${k}`, strand: rng.pick([1, -1] as const), segments, color: '#993366', qualifiers: [{ key: 'label', value: `b${k}` }, { key: 'note', value: `gene ${k} & product <${k}>` }] }));
    }
    features.push(makeFeature({ type: 'misc_feature', name: 'origin spanning', strand: 1, segments: [{ start: L - 100, end: L + 100 }], color: '#a6acb3' }));
    const record = makeRecord({ name: 'ecoli', seq, topology: 'circular', features });
    const started = Date.now();
    const data = writeSnapGene(record, { now: NOW });
    const back = parseSnapGene(data, { fileName: 'ecoli.dna' });
    const elapsed = Date.now() - started;
    expect(back.warnings).toEqual([]);
    expect(back.records[0].seq).toBe(seq);
    expect(back.records[0].features.map((f) => [f.name, f.strand, f.segments])).toEqual(features.map((f) => [f.name, f.strand, f.segments]));
    expect(elapsed).toBeLessThan(20000);
  }, 60000);
});
