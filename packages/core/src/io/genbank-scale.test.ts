/**
 * Regression tests for inputs much larger than typical files (review findings):
 *  - the reader and the writer never throw, however many lines or warnings a record has.
 *    `target.push(...array)` passes every element as a call argument, and engines cap the
 *    number of arguments by stack size (about 125 000 for V8 on a main thread, more in
 *    workers); such spreads of unbounded arrays threw `RangeError: Maximum call stack size
 *    exceeded`;
 *  - reading a location written over many lines takes linear time (it used to call
 *    `endsWith` on the growing concatenation after every line, which flattens it: quadratic).
 */
import { describe, expect, it } from 'vitest';
import { makeFeature, makeRecord } from '../seq/features';
import { parseGenbank, writeGenbank } from './genbank';
import { formatOrigin } from './genbank-sequence';

/**
 * A number of elements that overflows this engine's stack when spread into a call: the first
 * power of two from 2^17 up that throws (2^17 = 131 072 with V8's default stack). The tests
 * below use it so that they exercise the failure mode whatever the runtime's stack size.
 */
function overflowingSpreadCount(): number {
  const MAX = 1 << 20;
  for (let n = 1 << 17; n < MAX; n *= 2) {
    try {
      ([] as unknown[]).push(...new Array<unknown>(n));
    } catch {
      return n;
    }
  }
  return MAX;
}
const N = overflowingSpreadCount();

const LOCUS_0BP = 'LOCUS       empty                      0 bp    DNA     linear   SYN 01-JAN-2020';

/** Sequence lines of `seq` in the ORIGIN layout, without the ORIGIN keyword line. */
const sequenceLines = (seq: string) => formatOrigin(seq).slice(1);

describe('scale: parseGenbank never throws', () => {
  it(`returns a record that produces ${N} warnings`, () => {
    // Reviewer repro: every feature lies outside the empty sequence, one warning each.
    const lines = [LOCUS_0BP, 'FEATURES             Location/Qualifiers'];
    for (let k = 0; k < N; k++) lines.push('     misc_feature    1..10');
    lines.push('ORIGIN', '//');
    const r = parseGenbank(lines.join('\n'));
    expect(r.records).toHaveLength(1);
    expect(r.records[0].features).toEqual([]);
    expect(r.warnings).toHaveLength(N);
    expect(r.warnings[0]).toMatchObject({ line: 3, recordIndex: 0 });
    expect(r.warnings[N - 1]).toMatchObject({ line: N + 2, recordIndex: 0 });
  });

  it(`reads a header block of ${N} lines`, () => {
    const continuation = Array.from({ length: N }, (_, k) => `            Author${k},A.`);
    const text = [
      'LOCUS       x                         4 bp    DNA     linear   SYN 01-JAN-2020',
      'REFERENCE   1  (bases 1 to 4)',
      '  AUTHORS   Doe,J.',
      ...continuation,
      'ORIGIN',
      '        1 acgt',
      '//',
    ].join('\n');
    const r = parseGenbank(text);
    expect(r.warnings).toEqual([]);
    expect(r.records[0].seq).toBe('ACGT');
    expect(r.records[0].meta.extraHeaderLines).toHaveLength(N + 2);
    expect(r.records[0].meta.extraHeaderLines?.[N + 1]).toBe(`            Author${N - 1},A.`);
  });
});

describe('scale: writeGenbank never throws', () => {
  it(`writes header blocks, comments, a definition and a qualifier of ${N} lines each`, () => {
    // Words too long to share a line, so that every text below is written on N lines.
    const words = Array.from({ length: N }, (_, k) => `word${k}`.padEnd(40, 'x'));
    const record = makeRecord({
      name: 'big',
      description: words.join(' '),
      seq: 'ACGT',
      features: [makeFeature({ type: 'misc_feature', segments: [{ start: 0, end: 4 }], qualifiers: [{ key: 'note', value: words.join(' ') }] })],
      meta: {
        comments: [words.join('\n')],
        extraHeaderLines: ['REFERENCE   1  (bases 1 to 4)', ...words.map((w) => `            ${w}`)],
      },
    });
    const text = writeGenbank(record, { date: '01-JAN-2020' });
    const r = parseGenbank(text);
    expect(r.warnings).toEqual([]);
    const back = r.records[0];
    expect(back.description).toBe(record.description);
    expect(back.meta.comments).toEqual(record.meta.comments);
    expect(back.meta.extraHeaderLines).toEqual(record.meta.extraHeaderLines);
    expect(back.features[0].qualifiers).toEqual(record.features[0].qualifiers);
  });
});

describe('scale: a large genome whose ORIGIN keyword line is missing', () => {
  // Reviewer repro: more sequence lines (60 bases each) than a call takes arguments, directly
  // after the last header block. They used to become continuation lines of that block (and the
  // sequence N); now they are recognised by their numbering and read as the sequence.
  const seq = 'ACGTTGCAAGGCTTACCGTA'.repeat(Math.ceil((N * 60) / 20));
  const header = (lastBlock: string[]) =>
    [`LOCUS       BIG              ${String(seq.length).padStart(10)} bp    DNA     linear   BCT 01-JAN-2020`, 'DEFINITION  Large chromosome.', ...lastBlock];
  const recovered = (firstSequenceLine: number) => [
    {
      message: `no ORIGIN line: the ${Math.ceil(seq.length / 60)} numbered sequence line(s) from line ${firstSequenceLine} were read as the sequence`,
      line: firstSequenceLine,
      recordIndex: 0,
    },
  ];

  it('is read when the last header block is a REFERENCE', () => {
    const lastBlock = ['REFERENCE   1  (bases 1 to 9000000)', '  AUTHORS   Doe,J.', '  TITLE     Direct Submission'];
    const text = [...header(lastBlock), ...sequenceLines(seq), '//'].join('\n');
    const r = parseGenbank(text);
    expect(r.warnings).toEqual(recovered(6));
    expect(r.records[0].seq).toBe(seq);
    expect(r.records[0].meta.extraHeaderLines).toEqual(lastBlock);
  });

  it('is read and written when the last header block is a COMMENT', () => {
    const text = [...header(['COMMENT     Assembled.']), ...sequenceLines(seq), '//'].join('\n');
    const r = parseGenbank(text);
    expect(r.warnings).toEqual(recovered(4));
    expect(r.records[0].seq).toBe(seq);
    expect(r.records[0].meta.comments).toEqual(['Assembled.']);
    const again = parseGenbank(writeGenbank(r.records[0], { date: '01-JAN-2000' }));
    expect(again.warnings).toEqual([]);
    expect(again.records[0].seq).toBe(seq);
  });

  it('is read when the sequence lines follow the feature table', () => {
    // Each line used to be read as a feature (key '1', '61', ...) with one warning per line.
    const text = [
      ...header(['FEATURES             Location/Qualifiers', '     source          1..' + seq.length]),
      ...sequenceLines(seq),
      '//',
    ].join('\n');
    const r = parseGenbank(text);
    expect(r.warnings).toEqual(recovered(5));
    expect(r.records[0].seq).toBe(seq);
    expect(r.records[0].features.map((f) => f.type)).toEqual(['source']);
  });
});

describe('scale: linear-time reading', () => {
  it('reads a location written over tens of thousands of lines in linear time', () => {
    // Reviewer repro: an 80 000-part join wraps to ~26 000 lines. The quadratic assembly took
    // ~4 s here (and 4x more per doubling); linear reading of this 2.8 MB file takes ~0.1 s.
    const n = 80_000;
    const segments = Array.from({ length: n }, (_, k) => ({ start: k * 10, end: k * 10 + 5 }));
    const record = makeRecord({
      name: 'big',
      seq: 'A'.repeat(n * 10 + 10),
      features: [makeFeature({ type: 'misc_feature', name: 'm', segments, strand: 1 })],
    });
    const text = writeGenbank(record, { date: '01-JAN-2020' });
    const locationLines = text.slice(text.indexOf('join('), text.indexOf('/label')).split('\n').length;
    expect(locationLines).toBeGreaterThan(25_000);
    const t0 = performance.now();
    const r = parseGenbank(text);
    const elapsed = performance.now() - t0;
    expect(r.warnings).toEqual([]);
    expect(r.records[0].features[0].segments).toEqual(segments);
    expect(elapsed).toBeLessThan(1000);
  }, 60_000);
});
