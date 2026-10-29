import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';
import { parseAny, findSites, ENZYMES, digest } from '../src/index';

const fixture = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

it('smoke', () => {
  const r = parseAny(readFileSync(fixture('../../../apps/desktop/src/samples/pUC19.gb')), 'pUC19.gb');
  const rec = r.records[0];
  expect(rec.seq.length).toBe(2686);
  const s = parseAny(readFileSync(fixture('./fixtures/snapgene/pFA-KanMX4.dna')), 'pFA-KanMX4.dna');
  expect(s.records[0].features.length).toBeGreaterThan(0);
  const eco = ENZYMES.filter((e) => e.name === 'EcoRI');
  expect(findSites(rec.seq, rec.topology, eco).length).toBe(1);
  expect(digest(rec.seq, rec.topology, eco).length).toBe(1);
});
