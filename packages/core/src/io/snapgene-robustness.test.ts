/**
 * Robustness of the SnapGene reader on damaged input: truncation at every packet boundary,
 * seeded random mutations, garbage and pathological sizes. The reader must never throw or
 * hang, must return at most one record, and every record must satisfy the types.ts invariants.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFeature, makeRecord } from '../seq/features';
import { encodeUtf8, readPackets } from './snapgene-binary';
import { isSnapGeneFile, parseSnapGene, writeSnapGene, writeSnapGeneWithWarnings } from './snapgene';
import { DNA_COOKIE_PACKET, FIXTURE_DIR, ORACLE_DIR, Rng, concatBytes, dnaPacket, recordProblems, snapGenePacket } from '../../test/oracle/snapgene/testkit';

const inputs: Array<[string, Uint8Array]> = [
  ...readdirSync(FIXTURE_DIR)
    .filter((n) => n.endsWith('.dna'))
    .map((n): [string, Uint8Array] => [n, new Uint8Array(readFileSync(join(FIXTURE_DIR, n)))]),
  ...readdirSync(join(ORACLE_DIR, 'cases'))
    .filter((n) => n.endsWith('.dna'))
    .map((n): [string, Uint8Array] => [`cases/${n}`, new Uint8Array(readFileSync(join(ORACLE_DIR, 'cases', n)))]),
];

function checkSafe(data: Uint8Array, label: string): { records: number; warnings: number } {
  let result;
  try {
    result = parseSnapGene(data, { fileName: 'damaged.dna' });
  } catch (error) {
    throw new Error(`${label}: parseSnapGene threw ${String(error)}`);
  }
  expect(result.records.length, label).toBeLessThanOrEqual(1);
  for (const record of result.records) expect(recordProblems(record), label).toEqual([]);
  if (result.records.length === 0) expect(result.warnings.length, label).toBeGreaterThan(0);
  return { records: result.records.length, warnings: result.warnings.length };
}

describe('SnapGene reader on damaged files', () => {
  it('survives truncation at, around and between every packet boundary', () => {
    let checked = 0;
    const rng = new Rng(11);
    for (const [name, data] of inputs) {
      const cuts = new Set<number>([0, 1, 4, 5, 12, 13, 18, 19, 20]);
      for (const p of readPackets(data).packets) for (const d of [-1, 0, 1, 2, 4, 5, 6]) cuts.add(p.offset + d);
      for (let i = 0; i < 40; i++) cuts.add(rng.int(0, data.length));
      for (const cut of cuts) {
        if (cut < 0 || cut > data.length) continue;
        const { warnings } = checkSafe(data.subarray(0, cut), `${name} cut at ${cut}`);
        const cleanCut = cut === data.length || readPackets(data).packets.some((p) => p.offset === cut);
        if (!cleanCut && cut > 0) expect(warnings, `${name} cut at ${cut}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });

  it('survives 3000 seeded random mutations (byte flips, insertions, deletions, length corruption)', () => {
    const rng = new Rng(12);
    let withRecord = 0;
    for (let n = 0; n < 3000; n++) {
      const [name, original] = rng.pick(inputs);
      const bytes = Array.from(original);
      const edits = rng.int(1, 8);
      for (let e = 0; e < edits; e++) {
        const at = rng.int(0, Math.max(0, bytes.length - 1));
        const kind = rng.int(0, 4);
        if (kind === 0) bytes[at] = rng.int(0, 255);
        else if (kind === 1) bytes.splice(at, 0, rng.int(0, 255));
        else if (kind === 2) bytes.splice(at, rng.int(1, 16));
        else if (kind === 3) bytes[at] = rng.pick([0x3c, 0x3e, 0x26, 0x22, 0x2d, 0x00, 0x30]); // < > & " - NUL 0
        else {
          // corrupt a packet length field
          const packets = readPackets(Uint8Array.from(bytes)).packets;
          if (packets.length > 0) {
            const p = rng.pick(packets);
            bytes[p.offset + rng.int(1, 4)] = rng.int(0, 255);
          }
        }
      }
      withRecord += checkSafe(Uint8Array.from(bytes), `${name} mutant ${n}`).records;
    }
    expect(withRecord).toBeGreaterThan(1000);
  });

  it('rejects garbage behind a valid cookie without throwing', () => {
    const rng = new Rng(13);
    const cookie = [0x09, 0, 0, 0, 14, ...encodeUtf8('SnapGene'), 0, 1, 0, 15, 0, 19];
    for (let n = 0; n < 1000; n++) {
      const garbage = Array.from({ length: rng.int(0, 200) }, () => rng.int(0, 255));
      const data = Uint8Array.from([...cookie, ...garbage]);
      expect(isSnapGeneFile(data)).toBe(true);
      checkSafe(data, `garbage ${n}`);
    }
  });

  it('handles pathological sizes in linear time', () => {
    const cookie = [0x09, 0, 0, 0, 14, ...encodeUtf8('SnapGene'), 0, 1, 0, 15, 0, 19];
    // A packet that declares 4 GiB.
    const huge = parseSnapGene(Uint8Array.from([...cookie, 0x00, 0xff, 0xff, 0xff, 0xff, 0x02, 0x41]));
    expect(huge.records).toEqual([]);
    expect(huge.warnings[0].message).toMatch(/declares 4294967295 byte\(s\) but only 2 remain/);
    // 200 000 empty unknown packets after a DNA packet.
    const many = new Uint8Array(cookie.length + 7 + 200000 * 5);
    many.set(cookie);
    many.set([0x00, 0, 0, 0, 2, 0x02, 0x41], cookie.length);
    for (let i = 0; i < 200000; i++) many[cookie.length + 7 + i * 5] = 0x33;
    const started = Date.now();
    expect(parseSnapGene(many).records[0].seq).toBe('A');
    // Deeply nested XML and a feature with 20 000 segments.
    const deep = `<?xml version="1.0"?><Features>${'<a>'.repeat(5000)}${'</a>'.repeat(5000)}</Features>`;
    const segments = Array.from({ length: 20000 }, (_, i) => `<Segment range="${(i % 9) + 1}-${(i % 9) + 2}" type="standard"/>`).join('');
    const xml = (type: number, text: string) => {
      const body = encodeUtf8(text);
      return [type, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
    };
    const big = parseSnapGene(
      Uint8Array.from([...cookie, 0x00, 0, 0, 0, 11, 0x02, ...encodeUtf8('ACGTACGTAC'), ...xml(0x0a, deep), ...xml(0x0a, `<Features><Feature name="many">${segments}</Feature></Features>`)]),
    );
    expect(big.warnings[0].message).toMatch(/^Could not read the features/);
    expect(big.records[0].features[0].segments).toHaveLength(20000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------------------------
// Resource use on large or crafted files (regression tests for reviewed defects)
// ---------------------------------------------------------------------------------------------

/** Run `fn` and return its result with the elapsed wall-clock time in milliseconds. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

/** A minimal SnapGene file (cookie + `seq`) followed by the given XML packets. */
function crafted(seq: string, ...xml: Array<[number, string]>): Uint8Array {
  return concatBytes(DNA_COOKIE_PACKET, dnaPacket(seq), ...xml.map(([type, text]) => snapGenePacket(type, text)));
}

const WRITE_NOW = new Date(Date.UTC(2026, 0, 1));

/** For scale: the 11.3 MB SnapGene file of E. coli U00096.3 (9285 features) is read in about 0.5 s. */
const LINEAR_TIME_BUDGET_MS = 2000;

describe('SnapGene reader/writer: no argument-count limit on large files', () => {
  it('reads back a file with 140 000 features that writeSnapGene wrote without warnings', () => {
    // More arguments than V8 (~125 000 here) or JavaScriptCore (65 536) accept in one call.
    const features = Array.from({ length: 140_000 }, (_, k) =>
      makeFeature({ type: 'misc_feature', name: `f${k}`, segments: [{ start: k % 9990, end: (k % 9990) + 5 }], color: '#a6acb3' }),
    );
    const record = makeRecord({ name: 'big', seq: 'ACGT'.repeat(2500), features });
    const { data, warnings } = writeSnapGeneWithWarnings(record, { now: WRITE_NOW });
    expect(warnings).toEqual([]);
    const result = parseSnapGene(data, { fileName: 'big.dna' });
    expect(result.warnings).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].features).toHaveLength(140_000);
    expect(result.records[0].features[139_999]).toMatchObject({ name: 'f139999', segments: [{ start: 139_999 % 9990, end: (139_999 % 9990) + 5 }] });
  }, 120_000);

  it('reads a file with 140 000 primers', () => {
    const primers = Array.from({ length: 140_000 }, (_, k) => `<Primer name="p${k}" sequence="ACGTACGTACGTACGT"/>`).join('');
    const result = parseSnapGene(crafted('ACGTACGTAC', [0x05, `<Primers>${primers}</Primers>`]), { fileName: 'primers.dna' });
    expect(result.warnings).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].primers).toHaveLength(140_000);
    expect(result.records[0].primers[139_999].name).toBe('p139999');
  }, 120_000);

  it('writes a record with 70 000 notes fields (140 000 extras keys and values)', () => {
    const extras: Record<string, string> = {};
    for (let i = 0; i < 70_000; i++) extras[`F${i}`] = `v${i}`;
    const record = makeRecord({ seq: 'ACGTACGTAC', meta: { sourceFormat: 'snapgene', extras } });
    const { value, ms } = timed(() => writeSnapGeneWithWarnings(record, { now: WRITE_NOW }));
    expect(value.warnings).toEqual([]);
    const back = parseSnapGene(value.data, { fileName: 'fields.dna' }).records[0];
    expect(back.meta.extras?.F69999).toBe('v69999');
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS * 5);
  }, 120_000);
});

describe('SnapGene reader/writer: linear time on crafted input', () => {
  const readTime = (data: Uint8Array) =>
    timed(() => {
      const result = parseSnapGene(data, { fileName: 'crafted.dna' });
      expect(result.records).toHaveLength(1);
      return result;
    });

  it('reads a 1.05 MB file whose Description is "<!--" x 150 000 (HTML detection)', () => {
    const { value, ms } = readTime(crafted('ACGT', [0x06, `<Notes><Description>${'&lt;!--'.repeat(150_000)}</Description></Notes>`]));
    expect(value.records[0].description).toBe('<!--'.repeat(150_000)); // no "-->": plain text, kept verbatim
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 120_000);

  it('writes a record whose /note is "<!--" x 150 000 (plainToRichText -> HTML detection)', () => {
    const note = '<!--'.repeat(150_000);
    const record = makeRecord({
      seq: 'ACGTACGTAC',
      features: [makeFeature({ type: 'misc_feature', name: 'x', segments: [{ start: 0, end: 4 }], qualifiers: [{ key: 'note', value: note }] })],
    });
    const { value, ms } = timed(() => writeSnapGene(record, { now: WRITE_NOW }));
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    expect(parseSnapGene(value).records[0].features[0].qualifiers[0]).toEqual({ key: 'note', value: note });
  }, 120_000);

  it('reads a 358 KB file made of 10 000 small Notes packets', () => {
    const packets = Array.from({ length: 10_000 }, (_, i): [number, string] => [0x06, `<Notes><F${i}>v</F${i}></Notes>`]);
    const { value, ms } = readTime(crafted('ACGT', ...packets));
    expect(value.records[0].meta.extras?.F9999).toBe('v');
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 120_000);

  it('reads a 1.3 MB file with 60 000 <Comments> elements', () => {
    const { value, ms } = readTime(crafted('ACGT', [0x06, `<Notes>${'<Comments>c</Comments>'.repeat(60_000)}</Notes>`]));
    expect(value.records[0].meta.comments).toHaveLength(60_000);
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 120_000);

  it('reads a 1.4 MB file whose Comments start with 200 000 <br>', () => {
    const { value, ms } = readTime(crafted('ACGT', [0x06, `<Notes><Comments>&lt;html>&lt;body>${'&lt;br>'.repeat(200_000)}text&lt;/body>&lt;/html></Comments></Notes>`]));
    expect(value.records[0].meta.comments).toEqual(['text']);
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 120_000);

  it('reads a Comments value that ends with 200 000 <br>', () => {
    const { value, ms } = readTime(crafted('ACGT', [0x06, `<Notes><Comments>&lt;html>&lt;body>text${'&lt;br>'.repeat(200_000)}&lt;/body>&lt;/html></Comments></Notes>`]));
    expect(value.records[0].meta.comments).toEqual(['text']);
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 120_000);

  it('reads XML packets with long whitespace runs in front of a "=" without an attribute name (XMLValidator is quadratic there)', () => {
    // The reviewed reproduction: 100 KB of blanks between the tag name and a '=' took 9.4 s.
    const blanks = readTime(crafted('ACGTACGTAC', [0x0a, `<Features><Feature${' '.repeat(100_000)}=/></Features>`]));
    expect(blanks.value.warnings.map((w) => w.message)).toEqual(['Feature #1 has no valid segment; feature skipped.']);
    expect(blanks.ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    // 250 KB runs of tabs / line breaks after a value took about a minute; the packet is malformed and
    // the reported position is the one in the original text (line 250 002 after 250 000 line breaks).
    const tabs = readTime(crafted('ACGTACGTAC', [0x0a, `<Features><Feature name="x"${'\t'.repeat(250_000)}="y"><Segment range="1-4"/></Feature></Features>`]));
    expect(tabs.value.warnings[0].message).toMatch(/^Could not read the features of the SnapGene file \(packet 0x0a at offset 35: Attribute '"y"' has no space in starting\. \(line 1, column 250029\)\)/);
    expect(tabs.ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    const lines = readTime(crafted('ACGTACGTAC', [0x0a, `<Features>\n<Feature name="x"${'\n'.repeat(250_000)}="y"><Segment range="1-4"/></Feature></Features>`]));
    expect(lines.value.warnings[0].message).toMatch(/\(packet 0x0a at offset 35: Attribute '"y"' has no space in starting\. \(line 250002, column 2\)\)/);
    expect(lines.ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    // Any XML packet: primers, notes and sequence properties go through the same check.
    const primers = readTime(crafted('ACGTACGTAC', [0x05, `<Primers><Primer name="p" sequence="ACGTAC"${' '.repeat(250_000)}=/></Primers>`]));
    expect(primers.value.records[0].primers.map((p) => p.sequence)).toEqual(['ACGTAC']);
    expect(primers.ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    const notes = readTime(crafted('ACGTACGTAC', [0x06, `<Notes><Description a=${'\r\n'.repeat(125_000)}=>kept</Description></Notes>`]));
    expect(notes.value.warnings[0].message).toMatch(/^Could not read the notes of the SnapGene file \(packet 0x06 at offset 35: Attribute 'a' is without value\./);
    expect(notes.ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  }, 120_000);

  it('writes a record read from a SnapGene file with 10 000 unknown notes fields that have attributes', () => {
    const extras: Record<string, string> = {};
    for (let i = 0; i < 10_000; i++) {
      extras[`F${i}`] = 'v';
      extras[`F${i}.a`] = 'x';
    }
    const record = makeRecord({ seq: 'ACGTACGTAC', meta: { sourceFormat: 'snapgene', extras } });
    const { value, ms } = timed(() => writeSnapGene(record, { now: WRITE_NOW }));
    expect(ms).toBeLessThan(LINEAR_TIME_BUDGET_MS);
    expect(parseSnapGene(value).records[0].meta.extras).toMatchObject({ F9999: 'v', 'F9999.a': 'x' });
  }, 120_000);
});

describe('SnapGene reader: XML packets that are not valid UTF-8', () => {
  it('warns instead of silently turning undecodable bytes into U+FFFD', () => {
    // ISO-8859-1 text: µ = 0xB5, ® = 0xAE, ° = 0xB0 (invalid as UTF-8).
    const latin1 = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
    const notesPacket = snapGenePacket(0x06, latin1('<Notes><Description>grow at 37 °C</Description></Notes>'));
    const featuresPacket = snapGenePacket(
      0x0a,
      latin1('<Features><Feature name="neo" type="CDS"><Segment range="1-9"/><Q name="note"><V text="G418 50 µg/ml (Geneticin®)"/></Q></Feature></Features>'),
    );
    const data = concatBytes(DNA_COOKIE_PACKET, dnaPacket('ACGTACGTAC'), featuresPacket, notesPacket);
    const result = parseSnapGene(data, { fileName: 'latin1.dna' });
    expect(result.records[0].features[0].qualifiers[0].value).toBe('G418 50 �g/ml (Geneticin�)');
    expect(result.records[0].description).toBe('grow at 37 �C');
    const featuresOffset = DNA_COOKIE_PACKET.length + 5 + 11;
    const notesOffset = featuresOffset + featuresPacket.length;
    expect(result.warnings.map((w) => w.message)).toEqual([
      `The features packet (packet 0x0a at offset ${featuresOffset}) is not valid UTF-8: 2 invalid byte sequence(s) were replaced by U+FFFD.`,
      `The notes packet (packet 0x06 at offset ${notesOffset}) is not valid UTF-8: 1 invalid byte sequence(s) were replaced by U+FFFD.`,
    ]);
  });
});

describe('SnapGene reader: warning size', () => {
  const MAX_MESSAGE = 2000;
  const messages = (data: Uint8Array) => parseSnapGene(data, { fileName: 'damaged.dna' }).warnings.map((w) => w.message);

  it('keeps warning messages short for a 150 KB malformed features packet', () => {
    const result = parseSnapGene(crafted('ACGTACGTAC', [0x0a, `<Features>${'<a>'.repeat(50_000)}`]), { fileName: 'damaged.dna' }); // unclosed tags
    expect(result.records).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toMatch(/^Could not read the features of the SnapGene file \(packet 0x0a at offset 35: /);
    expect(result.warnings[0].message.length).toBeLessThan(MAX_MESSAGE);
  });

  it('clips untrusted text quoted in warnings (names, ranges, attribute values, root elements)', () => {
    const long = 'n'.repeat(50_000);
    const feature = (attributes: string, segment = '<Segment range="1-2"/>') => `<Feature ${attributes}>${segment}</Feature>`;
    const perFile = [
      messages(crafted('ACGTACGTAC', [0x0a, `<Features>${feature(`name="${long}" directionality="${long}"`)}</Features>`])),
      messages(crafted('ACGTACGTAC', [0x0a, `<Features>${feature('name="r"', `<Segment range="${long}"/>`)}</Features>`])),
      messages(crafted('ACGTACGTAC', [0x0a, `<Features>${feature('name="r"', `<Segment range="9${' '.repeat(50_000)}-2"/>`)}</Features>`])),
      messages(crafted('ACGTACGTAC', [0x0a, `<Features>${feature(`name="f" directionality="1" readingFrame="${long}"`)}</Features>`])),
      messages(crafted('ACGTACGTAC', [0x0a, `<Features>${feature('name="f" directionality="1" readingFrame="2"', `<Segment range="1-9"/><Q name="codon_start"><V text="${long}"/></Q>`)}</Features>`])),
      messages(crafted('ACGTACGTAC', [0x0a, `<${long}/>`])),
      messages(crafted('ACGTACGTAC', [0x05, `<Primers><Primer name="${long}" sequence="ACx"/><Primer name="${long}"/></Primers>`])),
      messages(crafted('ACGTACGTAC', [0x05, `<Primers><Primer name="p" sequence="${Array.from({ length: 5000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')}"/></Primers>`])),
      messages(crafted('ACGTACGTAC', [0x08, `<AdditionalSequenceProperties><UpstreamStickiness>${long}</UpstreamStickiness></AdditionalSequenceProperties>`])),
    ];
    // Per file: directionality; invalid range + feature skipped; range wrapping a linear sequence;
    // readingFrame; /codon_start; root element; removed characters + primer without sequence (twice); stickiness.
    expect(perFile.map((m) => m.length)).toEqual([1, 2, 1, 1, 1, 1, 2, 2, 1]);
    const all = perFile.flat();
    for (const message of all) expect(message.length, message.slice(0, 200)).toBeLessThan(500);
    // The clipped text says how long the original was.
    expect(all[0]).toMatch(/^Feature "n{60,}… \(50000 characters\)": unknown directionality "n{60,}… \(50000 characters\)"; read as non-directional\.$/);
  });
});
