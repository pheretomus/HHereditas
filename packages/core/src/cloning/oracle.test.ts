/**
 * Differential tests against pydna 5.5.16 (JSON written by tools/oracle/cloning_oracle.py).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGenbank } from '../io/genbank';
import { reverseComplement } from '../seq/alphabet';
import { makeRecord } from '../seq/features';
import { gibsonAssembly } from './gibson';
import { goldenGate } from './golden-gate';
import { pcr } from './pcr';
import { restrictionClone } from './restriction-cloning';
import { canonicalCircular } from './test-helpers';

const ORACLE = join(__dirname, '../../test/oracle/cloning');
const FIX = join(__dirname, '../../test/fixtures/genbank');
const load = <T>(name: string): { meta: unknown; cases: T[] } => JSON.parse(readFileSync(join(ORACLE, name), 'utf8'));
const TEMPLATES: Record<string, string> = {
  pUC19: parseGenbank(readFileSync(join(FIX, 'pUC19_M77789.gb'), 'utf8')).records[0].seq,
  pBR322: parseGenbank(readFileSync(join(FIX, 'pBR322_J01749.gb'), 'utf8')).records[0].seq,
};

describe('pcr vs pydna Anneal (limit 15)', () => {
  const { cases } = load<{ template: string; templateSeq: string | null; circular: boolean; forward: string; reverse: string; product: string | null }>('pcr.json');
  it(`agrees on all ${cases.length} cases`, () => {
    let withProduct = 0;
    for (const c of cases) {
      const seq = c.templateSeq ?? TEMPLATES[c.template];
      const tpl = makeRecord({ seq, topology: c.circular ? 'circular' : 'linear', name: c.template });
      const res = pcr(tpl, { id: 'F', name: 'F', sequence: c.forward }, { id: 'R', name: 'R', sequence: c.reverse });
      if (c.product === null) {
        expect(res.product, JSON.stringify(c)).toBeUndefined();
      } else {
        withProduct++;
        expect(res.products.map((p) => p.seq), JSON.stringify(c).slice(0, 300)).toEqual([c.product]);
      }
    }
    expect(withProduct).toBeGreaterThan(100);
  });
});

describe('restrictionClone vs pydna cut + ligation', () => {
  const { cases } = load<{ vector: string; vectorEnzymes: string[]; insertEnzymes: string[]; insert: string; products: Array<{ orientation: string; seq: string }> }>('ligation.json');
  it(`agrees on all ${cases.length} cases (circular products up to rotation)`, () => {
    for (const c of cases) {
      const vector = makeRecord({ seq: TEMPLATES[c.vector], topology: 'circular', name: c.vector });
      const res = restrictionClone({ vector, insert: makeRecord({ seq: c.insert, name: 'ins' }), vectorEnzymes: c.vectorEnzymes, insertEnzymes: c.insertEnzymes });
      const ours = res.products.map((p) => canonicalCircular(p.seq)).sort();
      const theirs = c.products.map((p) => canonicalCircular(p.seq)).sort();
      expect(ours, `${c.vector} ${c.vectorEnzymes} ${c.insertEnzymes}`).toEqual(theirs);
    }
  });
});

describe('gibsonAssembly vs pydna Assembly', () => {
  const { cases } = load<{ fragments: string[]; circular: boolean; minOverlap: number; expected: string; pydna: string[] }>('gibson.json');
  it(`agrees on all ${cases.length} cases`, () => {
    let compared = 0;
    for (const c of cases) {
      const res = gibsonAssembly(
        c.fragments.map((s, i) => makeRecord({ seq: s, name: `f${i}` })),
        { circular: c.circular, minOverlap: c.minOverlap },
      );
      expect(res.error, JSON.stringify(c).slice(0, 200)).toBeUndefined();
      const ours = res.product!.seq;
      if (c.circular) {
        expect(canonicalCircular(ours)).toBe(canonicalCircular(c.expected));
        for (const p of c.pydna) expect(canonicalCircular(p)).toBe(canonicalCircular(ours));
      } else {
        expect(ours).toBe(c.expected);
        for (const p of c.pydna) expect(p === ours || p === reverseComplement(ours)).toBe(true);
      }
      compared += c.pydna.length > 0 ? 1 : 0;
    }
    expect(compared).toBeGreaterThan(20);
  });
});

describe('goldenGate vs pydna cut + ligation', () => {
  const { cases } = load<{ parts: Array<{ seq: string; circular: boolean }>; product: string }>('golden_gate.json');
  it(`agrees on all ${cases.length} cases (shuffled input order)`, () => {
    for (const c of cases) {
      const parts = c.parts.map((p, i) => makeRecord({ seq: p.seq, topology: p.circular ? 'circular' : 'linear', name: `part${i}` }));
      const res = goldenGate(parts);
      expect(res.error).toBeUndefined();
      expect(canonicalCircular(res.product!.seq)).toBe(canonicalCircular(c.product));
    }
  });
});
