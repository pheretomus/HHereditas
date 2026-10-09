import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { parseAny, findSites, ENZYMES, digest } from '/home/srdgjuchdr/HHereditas/packages/core/src/index';
it('smoke', () => {
  const r = parseAny(readFileSync('/home/srdgjuchdr/HHereditas/apps/desktop/src/samples/pUC19.gb'), 'pUC19.gb');
  const rec = r.records[0];
  expect(rec.seq.length).toBe(2686);
  const s = parseAny(readFileSync('/home/srdgjuchdr/HHereditas/packages/core/test/fixtures/snapgene/pFA-KanMX4.dna'), 'pFA-KanMX4.dna');
  expect(s.records[0].features.length).toBeGreaterThan(0);
  const eco = ENZYMES.filter(e => e.name === 'EcoRI');
  expect(findSites(rec.seq, rec.topology, eco).length).toBe(1);
  expect(digest(rec.seq, rec.topology, eco).length).toBe(1);
});
