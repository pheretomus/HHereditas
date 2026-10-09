/**
 * Restriction cloning: digest a vector and an insert, pick the fragments, ligate them into
 * circular products, and check the junctions.
 */
import type { SeqRecord } from '../types';
import { mod } from '../seq/range';
import { getEnzyme } from '../enzymes/enzyme';
import type { RestrictionEnzyme } from '../enzymes/enzyme';
import { countCuts, findSites } from '../enzymes/search';
import { reverseComplementRecord, rotateOrigin } from '../ops/transform';
import { digestRecord } from './digest-record';
import type { DigestedRecord } from './digest-record';
import { endsCompatible, ligate } from './ligation';
import type { LigationJunction } from './ligation';
import type { CloningOutcome } from './result';
import { describeEnd, failure, leftOverhang, outcome, recordEnds, rightOverhang } from './result';

/** Options of {@link restrictionClone}. */
export interface RestrictionCloneOptions {
  vector: SeqRecord;
  insert: SeqRecord;
  /** Enzyme names (1 or 2) used to open the vector, e.g. ['EcoRI', 'BamHI']. */
  vectorEnzymes: readonly string[];
  /** Enzyme names used to cut the insert. Default: the vector enzymes. */
  insertEnzymes?: readonly string[];
  /** Vector fragment to keep: 'largest' (default) or an index into the vector's fragment list (parent order). */
  vectorFragment?: 'largest' | number;
  /** Insert fragment: 'auto' (default, see restrictionClone) or an index into the insert's fragment list. */
  insertFragment?: 'auto' | number;
  /** Orientations of the insert to try. Default 'both' (every orientation whose ends fit). */
  orientation?: 'both' | 'forward' | 'reverse';
}

/** One junction of a cloning product and whether its site is recut. */
export interface CloningJunction extends LigationJunction {
  /** Enzymes that made the two joined ends (vector end, insert end), possibly the same. */
  enzymes: string[];
  /** Enzymes among `enzymes` that cut the product exactly at this junction (site regenerated). */
  recutBy: string[];
}

/** Result of {@link restrictionClone}. */
export interface CloningResult extends CloningOutcome {
  /** The vector fragment used (from digestRecord), if one was chosen. */
  vectorFragment?: DigestedRecord;
  /** The insert fragment used, if one was chosen. */
  insertFragment?: DigestedRecord;
  /** Per product (same order): its orientation and its two junctions (vector→insert, insert→vector). */
  details: Array<{ orientation: 'forward' | 'reverse'; junctions: CloningJunction[] }>;
}

/**
 * Simulate classic restriction cloning.
 *
 * 1. The vector is digested with `vectorEnzymes`, the insert with `insertEnzymes` (default the
 *    same), each with {@link digestRecord}.
 * 2. Vector fragment: the largest one (by full length; ties: the first in parent order), or the given
 *    index. Insert fragment ('auto'): among the fragments whose two ends fit the two vector ends in at
 *    least one orientation (and that are not the vector fragment's own twin when vector and insert are
 *    the same record), prefer fragments cut at both ends (not original ends of a linear insert), then
 *    the longest, then the first in parent order. An index picks a fragment directly.
 * 3. The vector fragment is ligated with the insert (forward) or its reverse complement (reverse)
 *    into a circle (`ligate` with `circularize`). Products: forward first. When the vector fragment
 *    contains the vector's origin, the product is rotated so that the vector keeps its numbering.
 *
 * Names: `<vector>-<insert> (<enzymes>)`, with ` reverse` for the reverse orientation.
 *
 * Warnings: vector ends that fit each other (self-ligation background; single-enzyme or blunt
 * cloning); a non-directional insert (both orientations ligate); junctions whose site is not recut by
 * either enzyme that made its ends (hybrid sites such as BamHI/BglII, or blunt mixes); more than two
 * cuts in the insert (internal sites); a vector enzyme cutting more than once; an insert enzyme that
 * does not cut the insert.
 * Errors: unknown enzyme names, an enzyme that does not cut the vector, no insert fragment fitting
 * both vector ends, a requested orientation that does not fit, an out-of-range fragment index.
 */
export function restrictionClone(options: RestrictionCloneOptions): CloningResult {
  const warnings: string[] = [];
  const empty = { details: [] as CloningResult['details'] };
  const { vector, insert } = options;
  const vEnz = resolveEnzymes(options.vectorEnzymes);
  if (typeof vEnz === 'string') return failure(vEnz, warnings, empty);
  const iEnz = resolveEnzymes(options.insertEnzymes ?? options.vectorEnzymes);
  if (typeof iEnz === 'string') return failure(iEnz, warnings, empty);
  if (vEnz.length === 0) return failure('No vector enzyme given', warnings, empty);
  if (vEnz.length > 2) warnings.push(`${vEnz.length} vector enzymes given; classic cloning uses one or two`);

  // --- vector ---
  const vCounts = cutCounts(vector, vEnz);
  for (const e of vEnz) {
    const n = vCounts.get(e.name) ?? 0;
    if (n === 0) return failure(`${e.name} does not cut the vector '${vector.name}'`, warnings, empty);
    if (n > 1) warnings.push(`${e.name} cuts the vector ${n} times`);
  }
  const vFrags = digestRecord(vector, vEnz);
  let vFrag: DigestedRecord | undefined;
  if (options.vectorFragment === undefined || options.vectorFragment === 'largest') {
    for (const f of vFrags) if (vFrag === undefined || f.seq.length > vFrag.seq.length) vFrag = f;
  } else {
    vFrag = vFrags[options.vectorFragment];
    if (vFrag === undefined) return failure(`Vector fragment ${options.vectorFragment} does not exist (the digest gives ${vFrags.length})`, warnings, empty);
  }
  if (vFrag === undefined || vFrag.topology === 'circular') return failure('The vector is not opened by the enzymes', warnings, empty);
  if (endsCompatible(vFrag, vFrag)) {
    warnings.push('The vector ends are compatible with each other: the vector can self-ligate (dephosphorylate it, or expect background colonies)');
  }

  // --- insert ---
  const iCounts = cutCounts(insert, iEnz);
  let insertCuts = 0;
  for (const e of iEnz) {
    const n = iCounts.get(e.name) ?? 0;
    insertCuts += n;
    if (n === 0) warnings.push(`${e.name} does not cut the insert '${insert.name}'`);
  }
  // Two cuts release an insert; more mean an internal site that fragments it.
  if (insertCuts > 2) {
    const list = iEnz.map((e) => `${e.name} ×${iCounts.get(e.name) ?? 0}`).join(', ');
    warnings.push(`The insert is cut ${insertCuts} times (${list}): internal sites fragment it; check that the chosen fragment is the whole insert`);
  }
  const iFrags = digestRecord(insert, iEnz);
  const fits = (f: DigestedRecord): { forward: boolean; reverse: boolean } => {
    if (f.topology === 'circular') return { forward: false, reverse: false };
    const rc = reverseComplementRecord(f);
    return {
      forward: endsCompatible(vFrag, f) && endsCompatible(f, vFrag),
      reverse: endsCompatible(vFrag, rc) && endsCompatible(rc, vFrag),
    };
  };
  let iFrag: DigestedRecord | undefined;
  if (options.insertFragment === undefined || options.insertFragment === 'auto') {
    const sameSource = insert === vector;
    let best: { f: DigestedRecord; score: [number, number] } | undefined;
    for (const f of iFrags) {
      const fit = fits(f);
      if (!fit.forward && !fit.reverse) continue;
      if (sameSource && f.parentRange.start === vFrag.parentRange.start && f.parentRange.end === vFrag.parentRange.end) continue;
      const score: [number, number] = [f.leftCut && f.rightCut ? 1 : 0, f.seq.length];
      if (best === undefined || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { f, score };
    }
    iFrag = best?.f;
    if (iFrag === undefined) {
      const vl = describeEnd(recordEnds(vFrag).left, leftOverhang(vFrag));
      const vr = describeEnd(recordEnds(vFrag).right, rightOverhang(vFrag));
      return failure(
        `No insert fragment has ends compatible with both vector ends (vector: left ${vl}, right ${vr}; insert digest gave ${iFrags.length} fragment(s))`,
        warnings,
        { ...empty, vectorFragment: vFrag },
      );
    }
  } else {
    iFrag = iFrags[options.insertFragment];
    if (iFrag === undefined) return failure(`Insert fragment ${options.insertFragment} does not exist (the digest gives ${iFrags.length})`, warnings, { ...empty, vectorFragment: vFrag });
  }
  const fit = fits(iFrag);
  const want = options.orientation ?? 'both';
  const orientations: Array<'forward' | 'reverse'> = [];
  if (fit.forward && want !== 'reverse') orientations.push('forward');
  if (fit.reverse && want !== 'forward') orientations.push('reverse');
  if (orientations.length === 0) {
    const why = fit.forward || fit.reverse ? `only the ${fit.forward ? 'forward' : 'reverse'} orientation fits` : 'its ends do not fit the vector ends';
    return failure(`The insert fragment cannot be ligated ${want === 'both' ? '' : `in the ${want} orientation `}into the vector: ${why}`, warnings, {
      ...empty,
      vectorFragment: vFrag,
      insertFragment: iFrag,
    });
  }
  if (fit.forward && fit.reverse) warnings.push('Non-directional cloning: the insert can ligate in both orientations (screen colonies for the orientation)');

  // --- ligation ---
  const enzymeLabel = [...new Set([...vEnz, ...iEnz].map((e) => e.name))].join('/');
  const allEnzymes = uniqueByName([...vEnz, ...iEnz]);
  const products: SeqRecord[] = [];
  const details: CloningResult['details'] = [];
  for (const o of orientations) {
    const ins = o === 'forward' ? iFrag : reverseComplementRecord(iFrag);
    const insLeftCut = o === 'forward' ? iFrag.leftCut : iFrag.rightCut;
    const insRightCut = o === 'forward' ? iFrag.rightCut : iFrag.leftCut;
    const name = `${vector.name}-${insert.name} (${enzymeLabel})${o === 'reverse' ? ' reverse' : ''}`;
    const lig = ligate([vFrag, ins], { circularize: true, name });
    if (lig.product === undefined) {
      warnings.push(`The ${o} orientation could not be ligated: ${lig.error ?? 'unknown reason'}`);
      continue;
    }
    let product = lig.product;
    product.description = `${insert.name} cloned into ${vector.name} with ${enzymeLabel} (${o} orientation)`;
    const sites = findSites(product.seq, 'circular', allEnzymes);
    const T = product.seq.length;
    const junctions: CloningJunction[] = lig.junctions.map((j) => {
      const enzymes = j.leftPart === 0 ? [vFrag.rightCut?.enzyme, insLeftCut?.enzyme] : [insRightCut?.enzyme, vFrag.leftCut?.enzyme];
      const names = [...new Set(enzymes.filter((e): e is string => e !== undefined))];
      const recutBy = names.filter((e) => recuts(sites, e, j, T));
      return { ...j, enzymes: names, recutBy };
    });
    for (const j of junctions) {
      if (j.recutBy.length === 0 && j.enzymes.length > 0) {
        warnings.push(
          `${o === 'reverse' ? 'Reverse product' : 'Product'}: the ${j.enzymes.join('/')} junction at ${j.range.start + 1} ` +
            `${j.enzymes.length > 1 ? 'forms a hybrid site that is not recut by either enzyme' : 'is not recut by ' + j.enzymes[0]}`,
        );
      }
    }
    // Keep the vector's numbering when the kept vector fragment holds its origin.
    const L = vector.seq.length;
    if (vector.topology === 'circular' && vFrag.parentRange.end > L) {
      const shift = mod(L - vFrag.parentRange.start, T);
      product = { ...rotateOrigin(product, shift), name: product.name, description: product.description };
      for (const j of junctions) {
        const len = j.range.end - j.range.start;
        const start = mod(j.range.start - shift, T);
        j.range = { start, end: start + len };
      }
    }
    products.push(product);
    details.push({ orientation: o, junctions });
  }
  if (products.length === 0) return failure('No orientation of the insert could be ligated', warnings, { ...empty, vectorFragment: vFrag, insertFragment: iFrag });
  return outcome(products, warnings, { details, vectorFragment: vFrag, insertFragment: iFrag });
}

function resolveEnzymes(names: readonly string[]): RestrictionEnzyme[] | string {
  const out: RestrictionEnzyme[] = [];
  for (const n of names) {
    const e = getEnzyme(n);
    if (e === undefined) return `Unknown enzyme '${n}'`;
    out.push(e);
  }
  return uniqueByName(out);
}

function uniqueByName(list: readonly RestrictionEnzyme[]): RestrictionEnzyme[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

function cutCounts(rec: SeqRecord, enzymes: readonly RestrictionEnzyme[]): Map<string, number> {
  const opts = rec.topology === 'linear' && rec.ends !== undefined ? { ends: rec.ends } : {};
  return countCuts(findSites(rec.seq, rec.topology, enzymes, opts));
}

/**
 * True if `enzyme` cuts the circular product exactly at junction `j`: a cleavage event whose top and
 * bottom cuts are the two edges of the shared overhang (either order), or both at the gap of a blunt
 * junction.
 */
function recuts(sites: ReturnType<typeof findSites>, enzyme: string, j: LigationJunction, T: number): boolean {
  const a = mod(j.range.start, T);
  const b = mod(j.range.end, T);
  for (const s of sites) {
    if (s.enzyme !== enzyme) continue;
    for (const c of s.cuts) {
      if ((c.top === a && c.bottom === b) || (c.top === b && c.bottom === a)) return true;
    }
  }
  return false;
}
