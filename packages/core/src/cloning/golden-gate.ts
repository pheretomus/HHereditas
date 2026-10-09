/**
 * Golden Gate assembly with a Type IIS enzyme (BsaI by default): digest every part, keep the
 * site-free fragment, find the order from the overhangs and ligate.
 */
import type { SeqRecord } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { getEnzyme } from '../enzymes/enzyme';
import { findSitesForEnzyme } from '../enzymes/search';
import { reverseComplementRecord } from '../ops/transform';
import { digestRecord } from './digest-record';
import type { DigestedRecord } from './digest-record';
import type { AssemblyJunction, AssemblyResult } from './gibson';
import { endsCompatible, ligate } from './ligation';
import { failure, leftOverhang, outcome, overhangBases, recordEnds, rightOverhang } from './result';

/** Options of {@link goldenGate}. */
export interface GoldenGateOptions {
  /** Type IIS enzyme name. Default 'BsaI'. */
  enzyme?: string;
  /** Close the assembly into a circle. Default true. */
  circular?: boolean;
  /** Name of the product. Default 'Golden Gate assembly (<enzyme>)'. */
  name?: string;
}

/** Result of {@link goldenGate}. */
export interface GoldenGateResult extends AssemblyResult {
  /** The site-free fragment released from each part (same index as `parts`), when found. */
  fragments: DigestedRecord[];
  /** Assembly order: input part index and the orientation in which it is used. */
  order: Array<{ part: number; orientation: 'forward' | 'reverse' }>;
}

/** Maximum number of parts searched for an order (the search is exhaustive). */
const MAX_PARTS = 30;

/**
 * Simulate a one-pot Golden Gate assembly.
 *
 * 1. Each part (circular donor plasmid or linear PCR product) is digested with the enzyme
 *    ({@link digestRecord}); the part contributes the one fragment that was cut at both ends and
 *    holds no recognition site of the enzyme (on either strand), i.e. the fragment that is not recut
 *    in the one-pot reaction. A part without a site, or with zero or several such fragments, is an
 *    error.
 * 2. Overhangs: a palindromic overhang (equal to its own reverse complement, e.g. GATC) is an error
 *    (it can ligate to itself in both orientations); an overhang text that occurs on more than two
 *    ends (counting both strands) is an error (duplicate junction).
 * 3. Order: found from overhang compatibility (`endsCompatible`), NOT from the array order. Each part
 *    may be used in either orientation; the first part is always used forward (so a circular product is
 *    reported in that orientation, starting with part 0). Every part is used exactly once. No order:
 *    error naming unmatched overhangs; several orders: the first found is used and a warning lists the
 *    count.
 * 4. The fragments are ligated (`ligate`, circularized by default). Junctions report the shared
 *    overhang (`tm` is NaN: a 4-nt overhang has no meaningful duplex Tm). A product that still contains
 *    a site of the enzyme gets a warning (it would be recut).
 */
export function goldenGate(parts: readonly SeqRecord[], options: GoldenGateOptions = {}): GoldenGateResult {
  const warnings: string[] = [];
  const enzymeName = options.enzyme ?? 'BsaI';
  const circular = options.circular ?? true;
  const base = { junctions: [] as AssemblyJunction[], fragments: [] as DigestedRecord[], order: [] as GoldenGateResult['order'] };
  const enzyme = getEnzyme(enzymeName);
  if (enzyme === undefined) return failure(`Unknown enzyme '${enzymeName}'`, warnings, base);
  if (parts.length === 0) return failure('No parts given', warnings, base);
  if (parts.length > MAX_PARTS) return failure(`Too many parts (${parts.length}); at most ${MAX_PARTS} are supported`, warnings, base);

  // 1. Site-free fragment of each part.
  const fragments: DigestedRecord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const frags = digestRecord(part, [enzyme]);
    if (frags.length <= 1 && (frags[0]?.leftCut === undefined && frags[0]?.rightCut === undefined)) {
      return failure(`Part ${i + 1} ('${part.name}') is not cut by ${enzyme.name}`, warnings, { ...base, fragments });
    }
    const candidates = frags.filter(
      (f) => f.leftCut !== undefined && f.rightCut !== undefined && findSitesForEnzyme(f.seq, 'linear', enzyme, f.ends ? { ends: f.ends } : {}).length === 0,
    );
    if (candidates.length !== 1) {
      return failure(
        candidates.length === 0
          ? `Part ${i + 1} ('${part.name}') releases no ${enzyme.name}-free fragment cut at both ends`
          : `Part ${i + 1} ('${part.name}') releases ${candidates.length} ${enzyme.name}-free fragments: the part is ambiguous`,
        warnings,
        { ...base, fragments },
      );
    }
    const frag = candidates[0];
    const ends = recordEnds(frag);
    if (overhangBases(ends.left) === 0 || overhangBases(ends.right) === 0) {
      return failure(`Part ${i + 1} ('${part.name}'): ${enzyme.name} leaves blunt ends, Golden Gate needs overhangs`, warnings, { ...base, fragments });
    }
    fragments.push(frag);
  }

  // 2. Overhang checks.
  const counts = new Map<string, number>();
  for (let i = 0; i < fragments.length; i++) {
    for (const o of [leftOverhang(fragments[i]), rightOverhang(fragments[i])]) {
      const u = o.toUpperCase();
      if (u === reverseComplement(u)) {
        return failure(`Part ${i + 1} ('${parts[i].name}') has the palindromic overhang ${u}: it can self-ligate in both orientations`, warnings, { ...base, fragments });
      }
      const key = u < reverseComplement(u) ? u : reverseComplement(u);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const dup = [...counts].filter(([, c]) => c > 2).map(([o]) => o);
  if (dup.length > 0) {
    return failure(`Duplicate overhang(s) ${dup.join(', ')}: used by more than one junction, the assembly is ambiguous`, warnings, { ...base, fragments });
  }

  // 3. Order search (depth first; part 0 forward).
  const oriented = fragments.map((f) => ({ forward: f as SeqRecord, reverse: reverseComplementRecord(f) }));
  type Step = { part: number; orientation: 'forward' | 'reverse' };
  const solutions: Step[][] = [];
  const n = fragments.length;
  const used = new Array<boolean>(n).fill(false);
  const path: Step[] = [];
  const rec = (s: Step): SeqRecord => oriented[s.part][s.orientation];
  const extend = (): void => {
    if (solutions.length >= 2) return;
    if (path.length === n) {
      if (circular && !endsCompatible(rec(path[n - 1]), rec(path[0]))) return;
      if (path.some((s) => s.part === 0 && s.orientation === 'reverse')) return;
      solutions.push(path.slice());
      return;
    }
    const last = path[path.length - 1];
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      for (const orientation of ['forward', 'reverse'] as const) {
        const step = { part: j, orientation };
        if (!endsCompatible(rec(last), rec(step))) continue;
        used[j] = true;
        path.push(step);
        extend();
        path.pop();
        used[j] = false;
      }
    }
  };
  // Circular: start with part 0 forward. Linear: any start (part 0 must still be forward).
  const starts: Step[] = circular ? [{ part: 0, orientation: 'forward' }] : fragments.flatMap((_, j) => [{ part: j, orientation: 'forward' as const }, { part: j, orientation: 'reverse' as const }]);
  for (const s of starts) {
    used[s.part] = true;
    path.push(s);
    extend();
    path.pop();
    used[s.part] = false;
  }
  if (solutions.length === 0) {
    const unmatched: string[] = [];
    for (let i = 0; i < n; i++) {
      for (const [side, o] of [['left', leftOverhang(fragments[i])], ['right', rightOverhang(fragments[i])]] as const) {
        const key = o < reverseComplement(o) ? o : reverseComplement(o);
        if ((counts.get(key) ?? 0) < 2) unmatched.push(`${o} (part ${i + 1} ${side} end)`);
      }
    }
    const why = unmatched.length > 0 ? `unmatched overhang(s): ${unmatched.join(', ')}` : 'the overhangs do not form a single chain';
    return failure(`No assembly order uses every part${circular ? ' in a circle' : ''}: ${why}`, warnings, { ...base, fragments });
  }
  if (solutions.length > 1) warnings.push('More than one assembly order fits the overhangs; the first one found is shown');
  const order = solutions[0];

  // 4. Ligation.
  const lig = ligate(order.map(rec), { circularize: circular, name: options.name ?? `Golden Gate assembly (${enzyme.name})` });
  if (lig.product === undefined) return failure(lig.error ?? 'Ligation failed', warnings, { ...base, fragments, order });
  const product = lig.product;
  product.description = `Golden Gate assembly with ${enzyme.name} of ${order.map((s) => parts[s.part].name + (s.orientation === 'reverse' ? ' (rc)' : '')).join(', ')}`;
  const remaining = findSitesForEnzyme(product.seq, product.topology, enzyme, product.ends ? { ends: product.ends } : {});
  if (remaining.length > 0) warnings.push(`The product still contains ${remaining.length} ${enzyme.name} site(s): it would be recut in the one-pot reaction`);
  const junctions: AssemblyJunction[] = lig.junctions.map((j) => ({
    leftFragment: order[j.leftPart].part,
    rightFragment: order[j.rightPart].part,
    overlapLength: j.overhang.length,
    overlapSeq: j.overhang,
    tm: NaN,
    gc: j.overhang.length === 0 ? 0 : [...j.overhang].filter((c) => c === 'G' || c === 'C').length / j.overhang.length,
    range: j.range,
  }));
  return outcome([product], warnings, { junctions, fragments, order });
}
