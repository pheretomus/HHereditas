/**
 * Gibson / NEBuilder HiFi assembly: joining fragments through terminal sequence homology, and
 * designing the PCR primers that create those overlaps.
 *
 * Model: the 5'->3' exonuclease chews back the 5' ends, the exposed 3' single strands of
 * consecutive fragments anneal over their shared terminal sequence, and the polymerase and ligase
 * seal the joint. The product therefore contains each overlap once. Single-stranded (sticky) ends
 * of the input fragments are ignored: each fragment is read as its full top-strand `seq`.
 */
import type { Primer, Range, SeqRecord } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { newId } from '../seq/id';
import { mod, sliceRange } from '../seq/range';
import { oligoGcContent, tm } from '../primers/tm';
import { concatRecords, extractRange, rotateOrigin } from '../ops/transform';
import { pcr } from './pcr';
import type { CloningOutcome } from './result';
import { errorMessage, failure, outcome } from './result';

/** Options of {@link gibsonAssembly}. Lengths in bp. */
export interface GibsonOptions {
  /** Shortest accepted terminal homology. Default 15. */
  minOverlap?: number;
  /** Longest overlap considered (the longest homology up to this length is used). Default: no limit. */
  maxOverlap?: number;
  /** Close the last fragment onto the first. Default true. */
  circular?: boolean;
  /** Name of the product. Default 'Gibson assembly'. */
  name?: string;
}

/** One overlap junction of an assembly. */
export interface AssemblyJunction {
  /** 0-based indices (in the input array) of the fragment whose 3' end and the one whose 5' end overlap. */
  leftFragment: number;
  rightFragment: number;
  /** Overlap length in bp. */
  overlapLength: number;
  /** Overlap sequence, top strand 5'->3'. */
  overlapSeq: string;
  /** Overlap Tm in °C (`primers/tm` nearest-neighbour Tm under its default primer3 conditions). */
  tm: number;
  /** GC fraction 0..1 of the overlap. */
  gc: number;
  /** Where the overlap lies in the product (top-strand coordinates; the closing overlap of a circle starts at 0). */
  range: Range;
}

/** Result of {@link gibsonAssembly} and {@link goldenGate}: the common outcome plus the junctions. */
export interface AssemblyResult extends CloningOutcome {
  junctions: AssemblyJunction[];
}

/** Overlap Tm window in which Gibson / NEBuilder junctions behave well, °C (NEBuilder guidance: ~48-65 °C). */
export const GIBSON_OVERLAP_TM_RANGE = Object.freeze({ min: 48, max: 65 });

const DEFAULT_MIN_OVERLAP = 15;

/**
 * Length of the longest suffix of `a` that equals a prefix of `b`, limited to `max` (Knuth-Morris-
 * Pratt failure function of b + separator + a's tail). Returns 0 when there is none.
 */
export function terminalOverlap(a: string, b: string, max = Infinity): number {
  const cap = Math.min(a.length, b.length, max);
  if (cap <= 0) return 0;
  const s = `${b.slice(0, cap)}\u0000${a.slice(a.length - cap)}`;
  const pi = new Int32Array(s.length);
  for (let i = 1; i < s.length; i++) {
    let k = pi[i - 1];
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1];
    if (s[i] === s[k]) k++;
    pi[i] = k;
  }
  return pi[s.length - 1];
}

/**
 * Simulate a Gibson (isothermal) assembly of `fragments` in the given order.
 *
 * Junction rule: the 3' end of fragment i must share terminal homology with the 5' end of fragment
 * i + 1: the last k bases of fragment i equal the first k bases of fragment i + 1 (top strands,
 * case-insensitive), using the LONGEST such k with minOverlap <= k <= maxOverlap. With `circular`
 * (default) the last fragment also closes onto the first. Each overlap appears once in the product;
 * a linear product starts with fragment 0, a circular one too (its closing overlap at position 0).
 * Fragments are used as given: to use the reverse complement of a fragment, pass it reversed.
 *
 * Errors: fewer than one fragment, a circular fragment, a missing overlap (the message names the
 * junction and the longest homology found if shorter than minOverlap), a fragment that is all overlap.
 * Warnings: overlap Tm outside {@link GIBSON_OVERLAP_TM_RANGE}; an overlap sequence that also occurs
 * elsewhere in the fragments (either strand: possible mis-priming / alternative products); two
 * junctions with the same overlap; a fragment end that also overlaps a non-neighbouring fragment
 * (alternative assembly order); a fragment shorter than its two overlaps together; sticky ends ignored.
 * Features of all fragments are kept (shifted); features inside an overlap appear once per fragment.
 */
export function gibsonAssembly(fragments: readonly SeqRecord[], options: GibsonOptions = {}): AssemblyResult {
  const warnings: string[] = [];
  const empty = { junctions: [] as AssemblyJunction[] };
  const minOverlap = Math.max(1, options.minOverlap ?? DEFAULT_MIN_OVERLAP);
  const maxOverlap = options.maxOverlap ?? Infinity;
  const circular = options.circular ?? true;
  const n = fragments.length;
  if (n === 0) return failure('No fragments to assemble', warnings, empty);
  if (maxOverlap < minOverlap) return failure(`maxOverlap (${maxOverlap}) is smaller than minOverlap (${minOverlap})`, warnings, empty);
  for (let i = 0; i < n; i++) {
    if (fragments[i].topology === 'circular') return failure(`Fragment ${i + 1} ('${fragments[i].name}') is circular: linearize it first`, warnings, empty);
    if (fragments[i].seq.length === 0) return failure(`Fragment ${i + 1} ('${fragments[i].name}') is empty`, warnings, empty);
  }
  if (fragments.some((f) => f.ends !== undefined && (f.ends.left.kind !== 'blunt' || f.ends.right.kind !== 'blunt'))) {
    warnings.push('Single-stranded ends of the fragments are ignored: the exonuclease chews back the 5\' ends');
  }
  const seqs = fragments.map((f) => f.seq.toUpperCase());
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < n; i++) pairs.push([i, i + 1]);
  if (circular) pairs.push([n - 1, 0]);
  const ks: number[] = [];
  for (const [i, j] of pairs) {
    // A single fragment closing onto itself: the whole sequence is a trivial overlap, so look for a proper one.
    const k = terminalOverlap(seqs[i], seqs[j], i === j ? Math.min(maxOverlap, seqs[i].length - 1) : maxOverlap);
    const where = `${n === 1 ? 'closing fragment 1 onto itself' : `between fragment ${i + 1} ('${fragments[i].name}') and fragment ${j + 1} ('${fragments[j].name}')`}`;
    if (k < minOverlap) {
      return failure(
        k === 0 ? `No terminal overlap ${where}` : `Overlap too short ${where}: ${k} bp (minimum ${minOverlap} bp)`,
        warnings,
        empty,
      );
    }
    if (k >= seqs[i].length || k >= seqs[j].length) {
      return failure(`Fragment ${k >= seqs[j].length ? j + 1 : i + 1} lies entirely inside the overlap ${where}`, warnings, empty);
    }
    ks.push(k);
  }
  // Left / right overlap of each fragment.
  const leftK = new Array<number>(n).fill(0);
  const rightK = new Array<number>(n).fill(0);
  pairs.forEach(([i, j], p) => {
    rightK[i] = ks[p];
    leftK[j] = ks[p];
  });
  for (let i = 0; i < n; i++) {
    if (leftK[i] + rightK[i] > seqs[i].length) warnings.push(`Fragment ${i + 1} ('${fragments[i].name}') is shorter than its two overlaps together`);
  }
  // Product: the overlaps become synthetic shared 5' overhangs, which concatRecords merges.
  const parts: SeqRecord[] = fragments.map((f, i) => ({
    ...f,
    seq: seqs[i],
    ends: { left: end(leftK[i]), right: end(rightK[i]) },
  }));
  let product: SeqRecord;
  try {
    product = concatRecords(parts, { topology: circular ? 'circular' : 'linear', name: options.name ?? 'Gibson assembly' });
  } catch (e) {
    return failure(`Assembly failed: ${errorMessage(e)}`, warnings, empty);
  }
  delete product.ends;
  product.description = `Gibson assembly of ${fragments.map((f) => f.name).join(', ')}`;

  // Junction report, in product coordinates.
  const junctions: AssemblyJunction[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const k = leftK[i];
      junctions.push(junction(i - 1, i, seqs[i].slice(0, k), { start: pos - k, end: pos }));
      pos += seqs[i].length - k;
    } else {
      pos = seqs[0].length;
    }
  }
  if (circular) junctions.push(junction(n - 1, 0, seqs[0].slice(0, leftK[0]), { start: 0, end: leftK[0] }));

  // Quality checks.
  const bothStrands = seqs.map((s) => [s, reverseComplement(s)]);
  const seenOverlap = new Map<string, number>();
  junctions.forEach((j, idx) => {
    const label = `junction ${idx + 1} (fragment ${j.leftFragment + 1} → ${j.rightFragment + 1})`;
    if (!(j.tm >= GIBSON_OVERLAP_TM_RANGE.min && j.tm <= GIBSON_OVERLAP_TM_RANGE.max)) {
      warnings.push(`Overlap Tm of ${label} is ${j.tm.toFixed(1)} °C, outside the recommended ${GIBSON_OVERLAP_TM_RANGE.min}-${GIBSON_OVERLAP_TM_RANGE.max} °C`);
    }
    const canonical = j.overlapSeq < reverseComplement(j.overlapSeq) ? j.overlapSeq : reverseComplement(j.overlapSeq);
    const prev = seenOverlap.get(canonical);
    if (prev !== undefined) warnings.push(`Junctions ${prev + 1} and ${idx + 1} have the same overlap sequence: the assembly order is ambiguous`);
    else seenOverlap.set(canonical, idx);
    // Expected occurrences: the end of the left fragment and the start of the right one.
    const palindromic = j.overlapSeq === reverseComplement(j.overlapSeq);
    let extra = -2;
    for (let f = 0; f < n; f++) {
      for (const s of palindromic ? bothStrands[f].slice(0, 1) : bothStrands[f]) extra += countOccurrences(s, j.overlapSeq);
    }
    if (extra > 0) warnings.push(`The overlap of ${label} occurs ${extra} more time(s) in the fragments: possible mis-annealing`);
  });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || pairs.some(([a, b]) => a === i && b === j)) continue;
      const k = terminalOverlap(seqs[i], seqs[j], maxOverlap);
      if (k >= minOverlap) warnings.push(`The 3' end of fragment ${i + 1} also overlaps the 5' end of fragment ${j + 1} by ${k} bp: alternative assembly possible`);
    }
  }
  return outcome([product], warnings, { junctions });
}

function end(k: number): { kind: 'blunt' | '5prime'; length: number } {
  return k > 0 ? { kind: '5prime', length: k } : { kind: 'blunt', length: 0 };
}

function junction(left: number, right: number, overlapSeq: string, range: Range): AssemblyJunction {
  let t = NaN;
  let gc = NaN;
  try {
    t = tm(overlapSeq);
    gc = oligoGcContent(overlapSeq);
  } catch {
    // non-IUPAC characters: leave NaN
  }
  return { leftFragment: left, rightFragment: right, overlapLength: overlapSeq.length, overlapSeq, tm: t, gc, range };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Primer design
// ---------------------------------------------------------------------------

/** Options of {@link designGibsonPrimers}. Lengths in bp, temperatures in °C. */
export interface GibsonDesignOptions {
  /** Circular vector receiving the inserts. */
  vector: SeqRecord;
  /**
   * Region of the vector replaced by the inserts (normalized range; may cross the origin). A
   * zero-length range inserts at that gap position.
   */
  insertion: Range;
  /** Inserts in product order, each amplified whole (top strand as given). */
  inserts: readonly SeqRecord[];
  /** Overlap between neighbouring fragments. Default 20. */
  overlapLength?: number;
  /** Target Tm of each primer's annealing (template-binding) part. Default 60. */
  annealTargetTm?: number;
  /**
   * true (default): the vector is linearized by PCR (inverse PCR around the insertion site), and each
   * junction's overlap is split between the two neighbouring primers. false: the vector is used as is
   * (already linearized, e.g. by restriction digest, exactly at the insertion range) and the inserts'
   * primers carry the whole vector overlaps.
   */
  amplifyVector?: boolean;
}

/** Result of {@link designGibsonPrimers}. */
export interface GibsonDesign extends CloningOutcome {
  /** Designed primers: for each amplified fragment its forward then its reverse primer (vector first when amplified). */
  primers: Primer[];
  /** Fragments to assemble, in assembly order: vector backbone, then the inserts (PCR products of the primers). */
  fragments: SeqRecord[];
  /** Junctions of the assembly of `fragments`. */
  junctions: AssemblyJunction[];
}

/** Annealing lengths tried by the primer design (bp). */
const MIN_ANNEAL = 18;
const MAX_ANNEAL = 60;

/**
 * Design primers for a Gibson assembly of `inserts` into a circular vector, replacing `insertion`.
 *
 * Expected product (circular): vector bases before the insertion, the inserts in order, vector bases
 * after it; numbered like the vector when the insertion does not cross the origin (otherwise the
 * first kept vector base is base 0).
 *
 * Each fragment's primers = 5' overlap tail + annealing part. The annealing part is the shortest
 * stretch (18-60 bp, never longer than the fragment) at the fragment end whose Tm (`primers/tm`,
 * default conditions) reaches `annealTargetTm`. At a junction between pieces X and Y, the overlap is
 * the last ceil(o/2) bases of X followed by the first floor(o/2) bases of Y (o = overlapLength): Y's
 * forward primer carries X's part as its tail, X's reverse primer carries the reverse complement of
 * Y's part. With `amplifyVector: false`, the vector is not amplified and the inserts' primers carry
 * the whole overlap with the vector.
 *
 * Self-check: the fragments are made by {@link pcr} with the designed primers and joined by
 * {@link gibsonAssembly}; `product` is that assembly (rotated to the vector's numbering), and an
 * error is reported if it differs from the expected product. Warnings: annealing Tm not reached,
 * primers binding more than once, assembly warnings.
 * Errors: linear vector, invalid insertion range, no inserts, a fragment shorter than 18 bp.
 */
export function designGibsonPrimers(options: GibsonDesignOptions): GibsonDesign {
  const warnings: string[] = [];
  const empty = { primers: [] as Primer[], fragments: [] as SeqRecord[], junctions: [] as AssemblyJunction[] };
  const { vector, inserts } = options;
  const ov = options.overlapLength ?? 20;
  const target = options.annealTargetTm ?? 60;
  const amplifyVector = options.amplifyVector ?? true;
  const L = vector.seq.length;
  if (vector.topology !== 'circular') return failure('designGibsonPrimers needs a circular vector', warnings, empty);
  if (inserts.length === 0) return failure('No inserts given', warnings, empty);
  if (!Number.isInteger(ov) || ov < 10) return failure(`overlapLength must be an integer >= 10, got ${ov}`, warnings, empty);
  const ins = options.insertion;
  const span = ins.end - ins.start;
  if (!Number.isInteger(ins.start) || !Number.isInteger(ins.end) || ins.start < 0 || ins.start >= Math.max(L, 1) || span < 0 || span >= L) {
    return failure(`Invalid insertion range ${ins.start}..${ins.end} for a ${L} bp vector (must be normalized and shorter than the vector)`, warnings, empty);
  }
  const vSeq = vector.seq.toUpperCase();
  // Pieces in assembly order: backbone (from the insertion end around to its start), then the inserts.
  const backboneRange = { start: mod(ins.end, L), end: mod(ins.end, L) + (L - span) };
  const backboneSeq = sliceRange(vSeq, backboneRange);
  const pieces = [{ name: vector.name, seq: backboneSeq }, ...inserts.map((r) => ({ name: r.name, seq: r.seq.toUpperCase() }))];
  for (const p of pieces) {
    if (p.seq.length < MIN_ANNEAL) return failure(`'${p.name}' is only ${p.seq.length} bp: too short to amplify (put it into a primer tail instead)`, warnings, empty);
  }
  const m = pieces.length;
  // tailLeft[i]: bases of the previous piece added before piece i; tailRight[i]: bases of the next piece after it.
  const tailLeft: string[] = [];
  const tailRight: string[] = [];
  for (let i = 0; i < m; i++) {
    const prev = pieces[mod(i - 1, m)].seq;
    const next = pieces[mod(i + 1, m)].seq;
    let fromPrev = Math.ceil(ov / 2);
    let fromNext = Math.floor(ov / 2);
    if (!amplifyVector) {
      if (i === 1) fromPrev = ov; // the insert after the vector carries the whole overlap
      if (i === m - 1) fromNext = ov; // so does the insert before it
    }
    tailLeft.push(prev.slice(prev.length - Math.min(fromPrev, prev.length)));
    tailRight.push(next.slice(0, Math.min(fromNext, next.length)));
  }
  const primers: Primer[] = [];
  const fragments: SeqRecord[] = [];
  for (let i = 0; i < m; i++) {
    const piece = pieces[i];
    if (i === 0 && !amplifyVector) {
      const bb = extractRange(vector, backboneRange, { name: `${vector.name} backbone` });
      fragments.push(bb);
      continue;
    }
    const fAnneal = annealLength(piece.seq, target, false);
    const rAnneal = annealLength(piece.seq, target, true);
    for (const a of [fAnneal, rAnneal]) {
      if (a.tm < target) warnings.push(`'${piece.name}': annealing part reaches only ${a.tm.toFixed(1)} °C (${a.length} bp), target ${target} °C`);
    }
    const leftTail = tailLeft[i];
    const rightTail = tailRight[i];
    const fwd: Primer = { id: newId('p'), name: `${piece.name}-F`, sequence: leftTail + piece.seq.slice(0, fAnneal.length) };
    const rev: Primer = {
      id: newId('p'),
      name: `${piece.name}-R`,
      sequence: reverseComplement(piece.seq.slice(piece.seq.length - rAnneal.length) + rightTail),
    };
    fwd.description = `Gibson forward primer for ${piece.name}: ${leftTail.length} nt overlap tail + ${fAnneal.length} nt annealing (Tm ${fAnneal.tm.toFixed(1)} °C)`;
    rev.description = `Gibson reverse primer for ${piece.name}: ${rightTail.length} nt overlap tail + ${rAnneal.length} nt annealing (Tm ${rAnneal.tm.toFixed(1)} °C)`;
    primers.push(fwd, rev);
    const template = i === 0 ? vector : inserts[i - 1];
    const res = pcr(template, fwd, rev, { minAnneal: Math.min(15, fAnneal.length, rAnneal.length), name: `${piece.name} PCR (Gibson)` });
    const expectedLength = leftTail.length + piece.seq.length + rightTail.length;
    const prod = res.products.find((p) => p.seq.length === expectedLength && p.seq === leftTail + piece.seq + rightTail);
    if (prod === undefined) {
      return failure(`PCR of '${piece.name}' with the designed primers does not give the expected ${expectedLength} bp product${res.error ? `: ${res.error}` : ''}`, warnings, {
        ...empty,
        primers,
        fragments,
      });
    }
    if (res.products.length > 1) warnings.push(`PCR of '${piece.name}' with the designed primers gives ${res.products.length} products: a primer binds more than once`);
    fragments.push(prod);
  }
  const asm = gibsonAssembly(fragments, { minOverlap: Math.min(DEFAULT_MIN_OVERLAP, ov), circular: true, name: `${vector.name} + ${inserts.map((r) => r.name).join(' + ')}` });
  warnings.push(...asm.warnings);
  if (asm.product === undefined) return failure(`The designed fragments do not assemble: ${asm.error ?? ''}`, warnings, { ...empty, primers, fragments });

  // Expected product, numbered like the vector.
  const insertSeq = pieces.slice(1).map((p) => p.seq).join('');
  const wraps = ins.end > L;
  const expected = wraps ? sliceRange(vSeq, { start: ins.end - L, end: ins.start }) + insertSeq : vSeq.slice(0, ins.start) + insertSeq + vSeq.slice(ins.end);
  const T = asm.product.seq.length;
  // The product starts with the backbone fragment, whose first vector base vector[ins.end] follows its tail.
  const backboneTail = amplifyVector ? tailLeft[0].length : 0;
  const expectedPos = wraps ? 0 : ins.start + insertSeq.length;
  let product = rotateOrigin(asm.product, mod(backboneTail - expectedPos, T));
  product = { ...product, name: asm.product.name, description: `Gibson assembly of ${inserts.map((r) => r.name).join(', ')} into ${vector.name}` };
  if (product.seq !== expected) {
    return failure('Self-check failed: the assembled fragments do not give the expected product', warnings, { ...empty, primers, fragments, junctions: asm.junctions });
  }
  return outcome([product], warnings, { primers, fragments, junctions: asm.junctions });
}

/** Shortest annealing stretch at one end of `seq` reaching `target` °C (MIN_ANNEAL..MAX_ANNEAL bp). */
function annealLength(seq: string, target: number, fromRight: boolean): { length: number; tm: number } {
  const max = Math.min(MAX_ANNEAL, seq.length);
  let best = { length: max, tm: -Infinity };
  for (let n = Math.min(MIN_ANNEAL, max); n <= max; n++) {
    const part = fromRight ? reverseComplement(seq.slice(seq.length - n)) : seq.slice(0, n);
    const t = tm(part);
    if (t >= target) return { length: n, tm: t };
    if (n === max) best = { length: n, tm: t };
  }
  return best;
}
