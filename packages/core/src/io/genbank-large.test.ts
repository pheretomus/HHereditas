/**
 * The E. coli K-12 MG1655 genome (U00096.3, 11.7 MB, 4.6 Mb, ~9300 features): performance
 * and a compact comparison with Biopython 1.88 (counts, SHA-1 checksums, per-feature locations
 * and qualifier digests stored by tools/oracle/genbank_oracle.py). Skipped when the gitignored
 * fixture is absent (see test/fixtures/README).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, SeqRecord } from '../types';
import { splitAtOrigin } from '../seq/range';
import { GENBANK_EXTRA_KEYS, parseGenbank, writeGenbank } from './genbank';
import { biopythonQualifiers, type OracleFile } from '../../test/oracle/genbank/compare';

const LARGE = join(__dirname, '../../test/fixtures/large/ecoli_U00096.3.gb');
const ORACLE = join(__dirname, '../../test/oracle/genbank/biopython/large_ecoli_U00096.3.gb.json');

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Our feature location in the compact text form of genbank_oracle.py (`compact_location`):
 * Biopython parts in 5'->3' order, origin-spanning segments split in two, '<' / '>' on fuzzy ends.
 */
function compactLocation(f: Feature, L: number, circular: boolean): string {
  const strand = f.strand === 1 ? '+' : f.strand === -1 ? '-' : '.';
  const pieces = f.segments.flatMap((s) => (circular ? splitAtOrigin(s, L) : [s]));
  const texts = pieces.map((p, k) => {
    const start = (k === 0 && f.partialStart ? '<' : '') + p.start;
    const end = (k === pieces.length - 1 && f.partialEnd ? '>' : '') + p.end;
    return `${start}-${end}${strand}`;
  });
  return (f.strand === -1 ? texts.reverse() : texts).join(';');
}

describe.skipIf(!existsSync(LARGE))('E. coli genome (11.7 MB)', () => {
  let record: SeqRecord;
  let text = '';

  it('parses in under 3 s without warnings', () => {
    text = readFileSync(LARGE, 'utf8');
    const t0 = performance.now();
    const result = parseGenbank(text);
    const elapsed = performance.now() - t0;
    expect(result.warnings).toEqual([]);
    expect(result.records).toHaveLength(1);
    record = result.records[0];
    expect(elapsed).toBeLessThan(3000);
  });

  it('agrees with Biopython 1.88 on sequence, features, locations and qualifiers', async () => {
    const oracle = (JSON.parse(readFileSync(ORACLE, 'utf8')) as OracleFile).records[0];
    expect(record.name).toBe(oracle.name);
    expect(record.description).toBe(oracle.description);
    expect(record.seq.length).toBe(oracle.seqLength);
    expect(await sha1(record.seq)).toBe(oracle.seqSha1);
    expect(record.topology).toBe(oracle.topology);
    expect(record.meta.extras?.[GENBANK_EXTRA_KEYS.moleculeType]).toBe(oracle.moleculeType);
    expect(record.features).toHaveLength(oracle.featureCount);
    const counts: Record<string, number> = {};
    for (const f of record.features) counts[f.type] = (counts[f.type] ?? 0) + 1;
    expect(counts).toEqual(oracle.typeCounts);

    const circular = record.topology === 'circular';
    const L = record.seq.length;
    const compact = oracle.compactFeatures ?? [];
    const mismatches: string[] = [];
    for (let k = 0; k < compact.length; k++) {
      const f = record.features[k];
      const [type, location, digest, count] = compact[k];
      const qualifiers = biopythonQualifiers(f.qualifiers);
      const ours = (await sha1(qualifiers.map(([key, v]) => `${key}\u0001${v}`).join('\u0002'))).slice(0, 12);
      if (f.type !== type || compactLocation(f, L, circular) !== location || ours !== digest || qualifiers.length !== count) {
        mismatches.push(`#${k} ${type} ${location}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('reads the sequence when only the ORIGIN keyword line is missing (one warning, not 77 000)', () => {
    // Review finding: every sequence line used to be read as a feature ('1', '61', ...) with one
    // warning each (77 362 warnings, 13.6 MB of text) and the sequence replaced by N.
    const lines = text.split('\n');
    const origin = lines.findIndex((l) => l.startsWith('ORIGIN'));
    lines.splice(origin, 1);
    const t0 = performance.now();
    const result = parseGenbank(lines.join('\n'));
    const elapsed = performance.now() - t0;
    expect(result.warnings).toEqual([
      {
        message: `no ORIGIN line: the ${Math.ceil(record.seq.length / 60)} numbered sequence line(s) from line ${origin + 1} were read as the sequence`,
        line: origin + 1,
        recordIndex: 0,
      },
    ]);
    const strip = (r: SeqRecord) => ({ ...r, id: '', features: r.features.map((f) => ({ ...f, id: '' })) });
    expect(strip(result.records[0])).toEqual(strip(record));
    expect(elapsed).toBeLessThan(3000);
  });

  it('writes in under 3 s and reads its own output back identically', () => {
    const t0 = performance.now();
    const written = writeGenbank(record, { date: '01-JAN-2000' });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    const again = parseGenbank(written);
    expect(again.warnings).toEqual([]);
    const strip = (r: SeqRecord) => ({ ...r, id: '', features: r.features.map((f) => ({ ...f, id: '' })) });
    expect(strip(again.records[0])).toEqual(strip(record));
  });
});
