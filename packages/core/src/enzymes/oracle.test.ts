/**
 * Differential tests against Biopython 1.88 (site search) and pydna 5.5.16 (digests), using the
 * JSON written by tools/oracle/enzymes_oracle.py. See tools/oracle/enzymes_common.py for the
 * position conversion and the documented corrections of known Biopython defects.
 */
import { describe, expect, it } from 'vitest';
import { fragmentKey, readOracle } from '../../test/oracle/enzymes/load';
import type { DnaEnd, FragmentEnds, Topology } from '../types';
import { mod } from '../seq/range';
import { ENZYMES, getEnzyme } from './enzyme';
import type { RestrictionEnzyme } from './enzyme';
import { digest } from './digest';
import type { DigestFragment } from './digest';
import { findSitesForEnzyme } from './search';

interface PropsEntry {
  name: string;
  ovhg: number;
  deviation: string | null;
}
interface PlantedCase {
  enzyme: string;
  label: string;
  seq: string;
  linear: number[];
  circular: number[];
  biopython_linear?: number[];
  biopython_circular?: number[];
}
interface SharedFile {
  meta: { id: string; length: number };
  seq: string;
  results: Record<string, { linear: number[]; circular: number[]; biopython_linear?: number[]; biopython_circular?: number[] }>;
}
interface PydnaFragment {
  seq: string;
  ends: FragmentEnds;
  watson: string;
  crick: string;
  ovhg: number;
}
interface PydnaCase {
  group: string;
  enzymes: string[];
  topology: Topology;
  seq?: string;
  seqRef?: string;
  ends?: FragmentEnds;
  /** near_end cases: breaks pydna credits to one enzyme after rejecting another site making the same break. */
  shadowed?: number;
  fragments: PydnaFragment[];
}

function E(name: string): RestrictionEnzyme {
  const e = getEnzyme(name);
  if (e === undefined) throw new Error(`missing enzyme ${name}`);
  return e;
}

const props = new Map(readOracle<{ enzymes: PropsEntry[] }>('enzyme_props.json').enzymes.map((p) => [p.name, p]));

/** Biopython's overhang convention (top - bottom), corrected where its `ovhg` field is wrong. */
function ovhgOf(enzyme: RestrictionEnzyme): number {
  const p = props.get(enzyme.name) as PropsEntry;
  return p.deviation === 'ovhg-field' ? enzyme.cuts[0].top - enzyme.cuts[0].bottom : p.ovhg;
}

/** Our cleavage events as sorted 'top,bottom' strings, and the Biopython-derived expectation. */
function compareCuts(enzyme: RestrictionEnzyme, seq: string, topology: Topology, expectedTops: number[]): { ours: string[]; expected: string[] } {
  const L = seq.length;
  const ours = findSitesForEnzyme(seq, topology, enzyme).flatMap((s) => s.cuts.map((c) => [c.top, c.bottom]));
  const ovhg = ovhgOf(enzyme);
  const expected = expectedTops.map((t) => [t, topology === 'circular' ? mod(t - ovhg, L) : t - ovhg]);
  const fmt = (pairs: number[][]) => pairs.map(([t, b]) => `${t},${b}`).sort();
  return { ours: fmt(ours), expected: fmt(expected) };
}

describe('site search vs Biopython: planted sites for every enzyme (search_planted.json)', () => {
  const cases = readOracle<{ cases: PlantedCase[] }>('search_planted.json').cases;

  it('covers every catalogue enzyme', () => {
    expect(new Set(cases.map((c) => c.enzyme))).toEqual(new Set(ENZYMES.map((e) => e.name)));
  });

  it('reports the same cleavage events (top cuts, bottoms via the overhang)', () => {
    let comparisons = 0;
    let events = 0;
    let biopythonDefects = 0;
    for (const c of cases) {
      const enzyme = E(c.enzyme);
      for (const topology of ['linear', 'circular'] as const) {
        const { ours, expected } = compareCuts(enzyme, c.seq, topology, c[topology]);
        expect(ours, `${c.enzyme} ${c.label} ${topology} ${c.seq}`).toEqual(expected);
        comparisons++;
        events += ours.length;
        if (c[`biopython_${topology}`] !== undefined) biopythonDefects++;
      }
    }
    console.info(`planted: ${comparisons} enzyme/sequence/topology comparisons, ${events} cleavage events identical; ` +
      `${biopythonDefects} where plain Biopython search() differs because of a documented Biopython defect`);
    expect(comparisons).toBe(cases.length * 2);
  });

  it('differs from plain Biopython only for the documented enzymes', () => {
    const affected = new Set<string>();
    for (const c of cases) if (c.biopython_linear || c.biopython_circular) affected.add(c.enzyme);
    for (const name of affected) expect((props.get(name) as PropsEntry).deviation, name).not.toBeNull();
    expect([...affected].sort()).toEqual(['EcoBLMcrX', 'GdiII', 'HauII', 'Hin4I', 'LpnPI', 'MspJI', 'SgeI', 'SgrTI', 'TscAI', 'TspRI']);
  });
});

describe.each(['puc19', 'pbr322', 'random3k'])('site search vs Biopython: every enzyme on %s', (id) => {
  const data = readOracle<SharedFile>(`search_${id}.json`);

  it('reports the same cleavage events for all enzymes, linear and circular', () => {
    expect(data.seq).toHaveLength(data.meta.length);
    let events = 0;
    for (const enzyme of ENZYMES) {
      const r = data.results[enzyme.name];
      for (const topology of ['linear', 'circular'] as const) {
        const { ours, expected } = compareCuts(enzyme, data.seq, topology, r[topology]);
        expect(ours, `${enzyme.name} ${topology}`).toEqual(expected);
        events += ours.length;
      }
    }
    console.info(`${id}: ${ENZYMES.length} enzymes x 2 topologies, ${events} cleavage events identical`);
  });
});

describe.each(['single', 'multi', 'near_end'])('digest vs pydna Dseq.cut (pydna_digests_%s.json)', (part) => {
  const data = readOracle<{ sequences: Record<string, string>; cases: PydnaCase[] }>(`pydna_digests_${part}.json`);
  /** pydna's own fields, in the format of `fragmentKey` (which derives them from seq + ends). */
  const pydnaKey = (f: PydnaFragment) =>
    `${f.seq}|${f.ends.left.kind}:${f.ends.left.length}|${f.ends.right.kind}:${f.ends.right.length}|${f.watson}|${f.crick}|${f.ovhg}`;

  it('produces the same double-stranded fragments (strands, overhangs, end kinds and lengths)', () => {
    let fragments = 0;
    let uncut = 0;
    const groups = new Map<string, number>();
    for (const c of data.cases) {
      const seq = c.seq ?? data.sequences[c.seqRef as string];
      const ours: DigestFragment[] = digest(seq, c.topology, c.enzymes.map(E), c.ends ? { ends: c.ends } : undefined);
      const label = `${c.group} ${c.enzymes.join('+')} ${c.topology} ${seq.length} bp`;
      const expected = c.fragments.map(pydnaKey);
      if (expected.length === 0) {
        // pydna returns no fragment when nothing cuts; HHereditas returns the intact molecule
        const blunt: DnaEnd = { kind: 'blunt', length: 0 };
        expect(ours, label).toEqual([
          {
            seq,
            topology: c.topology,
            ends: c.topology === 'linear' ? (c.ends ?? { left: blunt, right: blunt }) : { left: blunt, right: blunt },
            parentRange: { start: 0, end: seq.length },
            length: seq.length,
          },
        ]);
        uncut++;
        continue;
      }
      const actual = ours.map((f) => fragmentKey(f.seq, f.ends));
      if (c.topology === 'linear' || expected.length <= 1) {
        expect(actual, label).toEqual(expected);
      } else {
        // pydna starts a circular digest at its first cut site; compare up to rotation
        const shift = expected.indexOf(actual[0]);
        expect(shift, label).toBeGreaterThanOrEqual(0);
        expect(actual, label).toEqual([...expected.slice(shift), ...expected.slice(0, shift)]);
      }
      fragments += actual.length;
      const group = c.group.split(':')[0];
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    console.info(
      `pydna (${part}): ${data.cases.length} digests, ${fragments} fragments identical (watson, crick, ovhg, ends), ` +
        `${uncut} uncut molecules; ${[...groups].map(([g, n]) => `${g} ${n}`).join(', ')}`,
    );
    expect(data.cases.length).toBeGreaterThan(200);
  });
});

describe('digest vs pydna: sites at single-stranded ends (pydna_digests_near_end.json)', () => {
  const data = readOracle<{ cases: PydnaCase[] }>('pydna_digests_near_end.json');

  it('covers sites across the ends and nested Type IIS sites whose outer site cannot cut', () => {
    // e.g. BsaI straddling a sticky end while the BsmAI site inside it makes the same break:
    // pydna rejects the BsaI cut and makes the break with BsmAI, as digest() does
    const shadowed = data.cases.filter((c) => (c.shadowed ?? 0) > 0);
    expect(shadowed.length).toBeGreaterThan(30);
    for (const c of shadowed) {
      const seq = c.seq as string;
      const ours = digest(seq, 'linear', c.enzymes.map(E), { ends: c.ends });
      expect(ours.length, `${c.enzymes.join('+')} ${JSON.stringify(c.ends)} ${seq}`).toBe(c.fragments.length);
    }
    expect(new Set(data.cases.map((c) => c.group))).toEqual(new Set(['near-end', 'near-end:nested']));
  });
});
