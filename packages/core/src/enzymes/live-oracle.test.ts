/**
 * Live differential test: random cases generated here (seeded; override with the environment
 * variable HH_ENZYMES_LIVE_SEED) are checked against Biopython and pydna by running
 * tools/oracle/enzymes_live.py in the oracle virtual environment. Skipped when the venv is absent.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { LIVE_ORACLE_SCRIPT, fragmentKey, instantiate, mulberry32, oraclePython, plant, randInt, randomDna, readOracle } from '../../test/oracle/enzymes/load';
import type { DnaEnd, FragmentEnds, Topology } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { mod } from '../seq/range';
import { ENZYMES, effectiveSiteLength, getEnzyme } from './enzyme';
import type { RestrictionEnzyme } from './enzyme';
import { digest } from './digest';
import { findSitesForEnzyme } from './search';

interface SearchCase {
  enzyme: string;
  seq: string;
  topology: Topology;
}
interface DigestCase {
  enzymes: string[];
  seq: string;
  topology: Topology;
  ends?: FragmentEnds;
  endMargin?: number;
}
/** Linear molecule with sticky ends and sites planted at (and across) the single-stranded ends. */
interface NearEndCase {
  enzymes: string[];
  seq: string;
  ends: FragmentEnds;
  /** Bottom-strand sites closer than this to an end make the case unreliable for pydna (see enzymes_common.py). */
  reverseMargin: number;
}
interface PydnaFragment {
  seq: string;
  ends: FragmentEnds;
  watson: string;
  crick: string;
  ovhg: number;
}
interface OracleResponse {
  search: Array<{ expected: number[]; biopython: number[]; deviation: string | null }>;
  digest: Array<{ conflict?: boolean; error?: string; fragments?: PydnaFragment[] }>;
  nearEnd: Array<{ unreliable?: boolean; conflict?: boolean; error?: string; shadowed?: number; fragments?: PydnaFragment[] }>;
}

/** pydna's own fields, in the format of `fragmentKey` (which derives them from seq + ends). */
const pydnaKey = (f: PydnaFragment) =>
  `${f.seq}|${f.ends.left.kind}:${f.ends.left.length}|${f.ends.right.kind}:${f.ends.right.length}|${f.watson}|${f.crick}|${f.ovhg}`;

const python = oraclePython();
const SEED = Number(process.env.HH_ENZYMES_LIVE_SEED ?? '20261009');
const deviation = new Map(readOracle<{ enzymes: Array<{ name: string; deviation: string | null }> }>('enzyme_props.json').enzymes.map((p) => [p.name, p.deviation]));

function E(name: string): RestrictionEnzyme {
  const e = getEnzyme(name);
  if (e === undefined) throw new Error(`missing enzyme ${name}`);
  return e;
}

/** Bases between a site and its farthest cut, plus the site length. */
function reach(e: RestrictionEnzyme): number {
  return e.site.length + Math.max(...e.cuts.flatMap((c) => [Math.abs(c.top), Math.abs(c.bottom)]));
}

function makeCases(): { search: SearchCase[]; digest: DigestCase[]; nearEnd: NearEndCase[] } {
  const rand = mulberry32(SEED);
  const search: SearchCase[] = [];
  for (let i = 0; i < 500; i++) {
    const enzyme = ENZYMES[randInt(rand, 0, ENZYMES.length - 1)];
    const topology: Topology = rand() < 0.5 ? 'linear' : 'circular';
    const n = enzyme.site.length;
    // Biopython wraps circular cuts only once: keep circles longer than any cut distance
    const L = topology === 'circular' ? randInt(rand, Math.max(n, 2 * reach(enzyme) + 2), 400) : randInt(rand, 1, 300);
    let seq = randomDna(L, rand);
    for (let k = randInt(rand, 0, 4); k > 0; k--) {
      let text = instantiate(enzyme.site, rand);
      if (rand() < 0.5) text = reverseComplement(text);
      if (n > L) break;
      const pos = topology === 'circular' ? randInt(rand, 0, L - 1) : rand() < 0.4 ? randInt(rand, 0, Math.min(L - n, reach(enzyme))) : randInt(rand, 0, L - n);
      seq = plant(seq, pos, text);
    }
    search.push({ enzyme: enzyme.name, seq, topology });
  }
  const pool = ENZYMES.filter((e) => deviation.get(e.name) === null && effectiveSiteLength(e.site) >= 4);
  const digestCases: DigestCase[] = [];
  for (let i = 0; i < 250; i++) {
    const enzymes = Array.from({ length: randInt(rand, 1, 3) }, () => pool[randInt(rand, 0, pool.length - 1)]);
    const topology: Topology = rand() < 0.5 ? 'linear' : 'circular';
    const sticky = topology === 'linear' && rand() < 0.3;
    const maxReach = Math.max(...enzymes.map(reach));
    const L = randInt(rand, Math.max(sticky ? 140 : 40, 2 * maxReach + 2), 700);
    let seq = randomDna(L, rand);
    for (let k = randInt(rand, 1, 4); k > 0; k--) {
      const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
      let text = instantiate(e.site, rand);
      if (rand() < 0.5) text = reverseComplement(text);
      const lo = sticky ? 50 + maxReach : 0;
      const hi = sticky ? L - 50 - maxReach - text.length : topology === 'circular' ? L - 1 : L - text.length;
      if (hi >= lo) seq = plant(seq, randInt(rand, lo, hi), text);
    }
    const end = (): DnaEnd => {
      const kind = (['blunt', '5prime', '3prime'] as const)[randInt(rand, 0, 2)];
      return { kind, length: kind === 'blunt' ? 0 : randInt(rand, 1, 6) };
    };
    const names = [...new Set(enzymes.map((e) => e.name))];
    digestCases.push(sticky ? { enzymes: names, seq, topology, ends: { left: end(), right: end() }, endMargin: 45 } : { enzymes: names, seq, topology });
  }
  // Sticky ends with sites AT the single-stranded ends, read on the top strand (pydna's site check
  // is only reliable for those; the oracle flags the other cases), and nested Type IIS pairs whose
  // outer site straddles the left end while the inner site makes the same break.
  const nested = [['BsaI', 'BsmAI'], ['BsmBI', 'BsmAI'], ['Esp3I', 'BsmAI'], ['SapI', 'EarI'], ['BspQI', 'EarI']].map((pair) => pair.map(E));
  const singleCut = pool.filter((e) => e.cuts.length === 1);
  const nearEnd: NearEndCase[] = [];
  for (let i = 0; i < 200; i++) {
    const outer = rand() < 0.5 ? nested[randInt(rand, 0, nested.length - 1)] : undefined;
    const picks = outer ?? Array.from({ length: randInt(rand, 1, 2) }, () => singleCut[randInt(rand, 0, singleCut.length - 1)]);
    if (outer !== undefined && rand() < 0.3) picks.push(singleCut[randInt(rand, 0, singleCut.length - 1)]);
    const enzymes = [...new Map(picks.map((e) => [e.name, e])).values()];
    const maxReach = Math.max(...enzymes.map(reach));
    const L = randInt(rand, Math.max(60, 4 * maxReach + 20), 220);
    const end = (stickyOnly: boolean): DnaEnd => {
      const kind = stickyOnly ? (['5prime', '3prime'] as const)[randInt(rand, 0, 1)] : (['blunt', '5prime', '3prime'] as const)[randInt(rand, 0, 2)];
      return { kind, length: kind === 'blunt' ? 0 : randInt(rand, 1, 8) };
    };
    const ends: FragmentEnds = { left: end(outer !== undefined), right: end(false) };
    let seq = randomDna(L, rand);
    if (outer !== undefined) seq = plant(seq, ends.left.length - 1, instantiate(outer[0].site, rand));
    for (let k = randInt(rand, 1, 3); k > 0; k--) {
      const e = enzymes[randInt(rand, 0, enzymes.length - 1)];
      const n = e.site.length;
      const u = rand();
      const pos = u < 0.35 ? ends.left.length - randInt(rand, 0, n) : u < 0.7 ? L - ends.right.length - n + randInt(rand, 0, n) : randInt(rand, 0, L - n);
      seq = plant(seq, Math.max(0, Math.min(L - n, pos)), instantiate(e.site, rand));
    }
    nearEnd.push({ enzymes: enzymes.map((e) => e.name), seq, ends, reverseMargin: 2 * maxReach + 10 });
  }
  return { search, digest: digestCases, nearEnd };
}

function runOracle(request: { search: SearchCase[]; digest: DigestCase[]; nearEnd: NearEndCase[] }): OracleResponse {
  const dir = mkdtempSync(join(tmpdir(), 'hh-enzymes-live-'));
  try {
    const path = join(dir, 'request.json');
    writeFileSync(path, JSON.stringify(request));
    const out = execFileSync(python as string, [LIVE_ORACLE_SCRIPT, path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(out) as OracleResponse;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(python === undefined)('live oracle: Biopython and pydna on cases generated at test time', () => {
  const cases = makeCases();
  let response: OracleResponse;

  beforeAll(() => {
    response = runOracle(cases);
  }, 120_000);

  it('site search agrees with Biopython (corrected only for documented defects)', () => {
    expect(response.search).toHaveLength(cases.search.length);
    let plainDiffers = 0;
    cases.search.forEach((c, i) => {
      const r = response.search[i];
      const enzyme = E(c.enzyme);
      const L = c.seq.length;
      const tops = findSitesForEnzyme(c.seq, c.topology, enzyme).flatMap((s) => s.cuts.map((cut) => cut.top)).sort((a, b) => a - b);
      expect(tops, `seed ${SEED} case ${i}: ${c.enzyme} ${c.topology} ${c.seq}`).toEqual(r.expected);
      // every top cut is within the molecule
      for (const t of tops) expect(c.topology === 'circular' ? t === mod(t, L) : t >= 1 && t <= L - 1).toBe(true);
      if (JSON.stringify(r.biopython) !== JSON.stringify(r.expected)) {
        plainDiffers++;
        expect(r.deviation, `plain Biopython differs for ${c.enzyme}`).not.toBeNull();
      }
    });
    console.info(`live search (seed ${SEED}): ${cases.search.length} cases identical; plain Biopython differs (documented defects) in ${plainDiffers}`);
  });

  it('digests agree with pydna', () => {
    expect(response.digest).toHaveLength(cases.digest.length);
    let compared = 0;
    let conflicts = 0;
    cases.digest.forEach((c, i) => {
      const r = response.digest[i];
      expect(r.error, `pydna error in case ${i}`).toBeUndefined();
      if (r.conflict) {
        conflicts++;
        return;
      }
      const ours = digest(c.seq, c.topology, c.enzymes.map(E), c.ends ? { ends: c.ends } : undefined).map((f) => fragmentKey(f.seq, f.ends));
      const blunt: DnaEnd = { kind: 'blunt', length: 0 };
      // pydna returns no fragment when nothing cuts; HHereditas returns the intact molecule
      const expected = (r.fragments ?? []).length > 0 ? (r.fragments ?? []).map(pydnaKey) : [fragmentKey(c.seq, c.ends ?? { left: blunt, right: blunt })];
      const label = `seed ${SEED} case ${i}: ${c.enzymes.join('+')} ${c.topology} ${c.seq}`;
      if (c.topology === 'circular' && expected.length > 1) {
        const shift = expected.indexOf(ours[0]);
        expect(shift, label).toBeGreaterThanOrEqual(0);
        expect(ours, label).toEqual([...expected.slice(shift), ...expected.slice(0, shift)]);
      } else {
        expect(ours, label).toEqual(expected);
      }
      compared++;
    });
    console.info(`live digest (seed ${SEED}): ${compared} digests identical, ${conflicts} skipped (conflicting cut zones, resolved by the documented rule)`);
    expect(compared).toBeGreaterThan(cases.digest.length / 2);
  });

  it('sticky-ended digests with sites at the single-stranded ends agree with pydna', () => {
    expect(response.nearEnd).toHaveLength(cases.nearEnd.length);
    let compared = 0;
    let shadowed = 0;
    let unreliable = 0;
    let conflicts = 0;
    cases.nearEnd.forEach((c, i) => {
      const r = response.nearEnd[i];
      const label = `seed ${SEED} near-end case ${i}: ${c.enzymes.join('+')} ${JSON.stringify(c.ends)} ${c.seq}`;
      expect(r.error, label).toBeUndefined();
      if (r.unreliable) {
        unreliable++;
        return;
      }
      if (r.conflict) {
        conflicts++;
        return;
      }
      const ours = digest(c.seq, 'linear', c.enzymes.map(E), { ends: c.ends }).map((f) => fragmentKey(f.seq, f.ends));
      // pydna returns no fragment when nothing cuts; HHereditas returns the intact molecule
      const expected = (r.fragments ?? []).length > 0 ? (r.fragments ?? []).map(pydnaKey) : [fragmentKey(c.seq, c.ends)];
      expect(ours, label).toEqual(expected);
      compared++;
      shadowed += r.shadowed ?? 0;
    });
    console.info(
      `live near-end (seed ${SEED}): ${compared} digests identical (${shadowed} breaks made by a site nested in one that cannot cut), ` +
        `${unreliable} skipped (pydna site check unreliable), ${conflicts} skipped (conflicting or end-touching cut zones)`,
    );
    expect(compared).toBeGreaterThan(cases.nearEnd.length / 2);
    expect(shadowed).toBeGreaterThan(0);
  });
});
