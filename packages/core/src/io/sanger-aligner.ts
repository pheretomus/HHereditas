/**
 * Sanger read -> plasmid aligner (seed - chain - extend, quality-aware scoring, significance-based acceptance).
 * Chosen over seven other engines on synthetic suites and on real SnapGene / .ab1 data (scratch benchmark, Oct 2026).
 *
 *  1. Read: 2-bit codes of both strands + Phred values (Q30 when the read has none); modified-Mott clear range
 *     (snapgene / tracy), used only to judge the read ends in step 8.
 *  2. Seeds: exact k-mer hits from a cached, typed-array, hashed k-mer index of the reference (minimap2 / tracy2),
 *     merged into maximal same-diagonal runs (anchors).
 *  3. Chaining: colinear DP over the anchors with a 2-piece gap cost, so a jump of any size up to the plasmid length
 *     chains cheaply (snapgene's "any span" chaining, minimap2's capped long-gap cost); a chain never covers more than
 *     the plasmid (snapgene's no-wrap rule).
 *  4. Fill: quality-aware banded Gotoh DP (tracy): match/mismatch log-odds from each base's Phred value, 2-piece affine
 *     gaps whose short piece gets cheaper at low-quality bases. Between anchors a banded global DP and/or two banded
 *     extensions joined by one long I/D (splice-style junction); X-drop extensions at both ends over the whole read.
 *  5. Chain ends attached over a long gap are dropped when that raises the score, unless they are significant on their
 *     own and dropping gains little (flank rule).
 *  6. Clipped-end rescue (blockaligner / parasail): a clipped read end is re-seeded with 8-mers and joined to the
 *     alignment with I/D when the rescued piece is significant on its own and not explained better elsewhere.
 *  7. Acceptance by an E-value-like score threshold (Karlin-Altschul: log2(m * n) + constant), whatever fraction of the
 *     read is covered, so short partial matches are reported.
 *  8. Noisy ends clipped by a maximum-scoring stretch over the columns (snapgene's bestStretch), stricter outside the
 *     clear range; a weak end block beyond a long gap is dropped.
 *
 * Pure function of its inputs; the only module-level state is a small cache (<= 4 references) of reference indexes,
 * each with its own scratch buffers.
 */

export interface SangerReadInput {
  /** The read as sequenced, 5' -> 3' (A/C/G/T/N; other IUPAC codes count as N). */
  seq: string;
  /** Phred quality per base of `seq` (same length), when the read comes from a chromatogram. */
  qual?: number[];
}

export interface SangerAlignResult {
  /** False when no significant match was found. */
  aligned: boolean;
  /** 1: the read matches the top strand; -1: its reverse complement does. */
  strand: 1 | -1;
  /** Reference position (0-based, in [0, ref.length)) of the first M/D operation of `cigar`. */
  refStart: number;
  /**
   * CIGAR in reference orientation over the oriented read (`seq`, or its reverse complement for strand -1).
   * Ops M, I, D and S (ends only). On a circular reference the positions continue past the end (modulo ref.length).
   */
  cigar: string;
}

// ---- parameters ----------------------------------------------------------------------------------------------
const P = {
  mottCutoff: 0.2, // Mott clear range: max-sum segment of (cutoff - Perr); 0.2 <=> Q7
  minTrimmed: 20, // shorter clear ranges fall back to the whole read
  extendFull: true, // end extensions run over the whole read (snapgene), not only the clear range (tracy)
  defaultQ: 30, // Phred assumed for reads without qualities
  k: 11, // seed length (references <= 64 kb)
  kLarge: 13, // seed length for larger references
  maxOcc: 16, // k-mers occurring more often in the reference are not used as seeds
  mismatchCap: 6, // mismatch penalty never exceeds this (bits)
  gapOpen1: 6, // short gap piece: open + extend * len, scaled by the quality factor
  gapExt1: 1,
  gapOpen2: 28, // long gap piece: nearly free per base, so deletions up to the plasmid length stay joinable
  gapExt2: 0.005,
  qGapFull: 30, // short-gap costs reach full value at this Phred; below they scale down linearly ...
  qGapMin: 0.6, // ... but not below this fraction
  chainLookback: 64, // predecessors examined per anchor in the chaining DP (+ the 8 best so far)
  chainMatch: 1.8, // chain weight per anchored base
  chainGapOpen2: 12, // chain-level long-gap open
  band: 12, // half band of extensions
  splitMin: 20, // gap fills with a read gap longer than this also try the split junction
  globalMaxDiff: 40, // gap fills with |ref gap - read gap| above this use the split junction
  xdrop: 40,
  sigConst: 16, // acceptance: score >= sigConst + log2(readLen * 2 * refLen) (calib.ts: chance max at +14.4)
  minScoreFloor: 36, // ... and never below this
  flankRule: true, // keep a far chain end when it is significant on its own
  joinSlack: 30, // ... unless dropping it raises the alignment score by more than this
  segConst: 18, // a far chain end is significant when its own score >= segConst + log2(segLen * 2 * refLen)
  rescue: true, // re-seed clipped read ends
  rescueK: 8,
  rescueMin: 24, // clipped ends shorter than this are not re-seeded
  rescueOtherMargin: 4, // ... nor joined when a non-colinear hit of the clipped part is this much longer
  clip: true, // final max-scoring-stretch clip of noisy alignment ends
  clipMatch: 1,
  clipMis: 3,
  clipGap: 2,
  clipMisOut: 4, // ... outside the Mott clear range
  clipGapOut: 2,
  clipGapCap: 10,
  clipLongGap: 20,
  clipMinBlock: 16,
};

const COMPC = new Int8Array([3, 2, 1, 0]);
const CODE = new Int8Array(128).fill(-1);
CODE[65] = 0; CODE[67] = 1; CODE[71] = 2; CODE[84] = 3; CODE[85] = 3;
CODE[97] = 0; CODE[99] = 1; CODE[103] = 2; CODE[116] = 3; CODE[117] = 3;
const NEG = -1e30;
const OP_M = 77, OP_I = 73, OP_D = 68;

// ---- scoring tables ------------------------------------------------------------------------------------------
const MATCH = new Float64Array(100), MISM = new Float64Array(100), GQ = new Float64Array(100), PERR = new Float64Array(100);
/** Fills the per-Phred score tables from P. */
function buildTables(): void {
  for (let q = 0; q < 100; q++) {
    const e = Math.min(0.75, Math.pow(10, -Math.max(q, 1) / 10));
    PERR[q] = Math.pow(10, -q / 10);
    MATCH[q] = Math.min(2, Math.log2((1 - e) / 0.25));
    MISM[q] = -Math.min(P.mismatchCap, -Math.log2(e / 3 / 0.25));
    GQ[q] = Math.max(P.qGapMin, Math.min(1, q / P.qGapFull));
  }
}
buildTables();
function chainGapCost(len: number): number {
  if (len <= 0) return 0;
  return Math.min(P.gapOpen1 + P.gapExt1 * len, P.chainGapOpen2 + P.gapExt2 * len);
}
function gapCost(len: number): number {
  return len <= 0 ? 0 : Math.min(P.gapOpen1 + P.gapExt1 * len, P.gapOpen2 + P.gapExt2 * len);
}

// ---- reference index + per-reference scratch space --------------------------------------------------------------
interface Index {
  ref: string;
  circular: boolean;
  L: number;
  k: number;
  hbits: number;
  head: Int32Array;
  next: Int32Array;
  km: Int32Array;
  /** Reference codes at [L, 2L); circular: copies at [0, L) and [2L, 3L); linear: -2 (off the reference) there. */
  ref3: Int8Array;
  ws: Work;
  /** Small-k index for the clipped-end rescue, built on first use. */
  small: Index | null;
}
interface Work {
  cap: number;
  RQ: Int8Array; // oriented read codes, both strands: [fwd | rev]
  RQQ: Uint8Array;
  diagLast: Int32Array;
  diagRun: Int32Array;
  AQ: Int32Array; AR: Int32Array; AL: Int32Array;
  CF: Float64Array; CP: Int32Array; COV: Int32Array; CS: Int32Array; // CS: reference span from the chain's first anchor
  TB1: Uint8Array; TB2: Uint8Array; TB3: Uint8Array;
  H0: Float64Array; H1: Float64Array; F1: Float64Array; F2: Float64Array;
  R1S: Float64Array; R1J: Int32Array; R2S: Float64Array; R2J: Int32Array;
}
const MAXA = 1 << 14;

/** Reference indexes keyed by the reference string itself (its hash is cached by the engine; no key building). */
const CACHE = new Map<string, Index[]>();
function getIndex(ref: string, circular: boolean, k: number): Index {
  let list = CACHE.get(ref);
  const hit = list?.find((x) => x.circular === circular && x.k === k);
  if (hit) return hit;
  const idx = buildIndex(ref, circular, k, null);
  if (!list) {
    if (CACHE.size >= 4) CACHE.delete(CACHE.keys().next().value as string);
    CACHE.set(ref, (list = []));
  }
  list.push(idx);
  return idx;
}

function buildIndex(ref: string, circular: boolean, k: number, ws: Work | null): Index {
  const L = ref.length, mask = (1 << (2 * k)) - 1;
  // hashed k-mer table sized to the reference (a direct 4^k table costs milliseconds to allocate)
  let hbits = 10;
  while (1 << hbits < 2 * L) hbits++;
  const head = new Int32Array(1 << hbits).fill(-1), next = new Int32Array(L).fill(-1), km = new Int32Array(L).fill(-1);
  const end = circular ? L + k - 1 : L;
  let h = 0, valid = 0;
  for (let p = 0; p < end; p++) {
    const c = CODE[ref.charCodeAt(p % L) & 127];
    if (c < 0) { valid = 0; h = 0; continue; }
    h = ((h << 2) | c) & mask; valid++;
    if (valid >= k) {
      const s = (p - k + 1) % L, bk = Math.imul(h, -1640531535) >>> (32 - hbits);
      km[s] = h; next[s] = head[bk]; head[bk] = s;
    }
  }
  const ref3 = new Int8Array(3 * L).fill(-2);
  for (let p = 0; p < L; p++) {
    const c = CODE[ref.charCodeAt(p) & 127];
    const v = c < 0 ? -1 : c;
    ref3[L + p] = v;
    if (circular) { ref3[p] = v; ref3[2 * L + p] = v; }
  }
  return { ref, circular, L, k, hbits, head, next, km, ref3, ws: ws ?? newWork(L), small: null };
}

function newWork(L: number): Work {
  return {
    cap: 0, RQ: new Int8Array(0), RQQ: new Uint8Array(0),
    diagLast: new Int32Array(0), diagRun: new Int32Array(0),
    AQ: new Int32Array(MAXA), AR: new Int32Array(MAXA), AL: new Int32Array(MAXA),
    CF: new Float64Array(MAXA), CP: new Int32Array(MAXA), COV: new Int32Array(MAXA), CS: new Int32Array(MAXA),
    TB1: new Uint8Array(1 << 15), TB2: new Uint8Array(1 << 15), TB3: new Uint8Array(1 << 15),
    H0: new Float64Array(Math.min(L, 4096) + 2), H1: new Float64Array(Math.min(L, 4096) + 2),
    F1: new Float64Array(Math.min(L, 4096) + 2), F2: new Float64Array(Math.min(L, 4096) + 2),
    R1S: new Float64Array(2048), R1J: new Int32Array(2048), R2S: new Float64Array(2048), R2J: new Int32Array(2048),
  };
}

function ensureRead(ws: Work, n: number, L: number): void {
  if (n > ws.cap) {
    ws.cap = Math.max(n, ws.cap * 2, 2048);
    ws.RQ = new Int8Array(2 * ws.cap); ws.RQQ = new Uint8Array(2 * ws.cap);
  }
  // diagonals: circular -> [0, L); linear -> p - q + n in [0, L + n]
  if (ws.diagLast.length < L + ws.cap + 1) {
    ws.diagLast = new Int32Array(L + ws.cap + 1).fill(-2);
    ws.diagRun = new Int32Array(L + ws.cap + 1);
  }
}
function ensureDP(ws: Work, m: number, n: number): void {
  if (ws.H0.length < m + 2) {
    const s = Math.max(m + 2, ws.H0.length * 2);
    ws.H0 = new Float64Array(s); ws.H1 = new Float64Array(s); ws.F1 = new Float64Array(s); ws.F2 = new Float64Array(s);
  }
  if (ws.R1S.length < n + 2) {
    const s = Math.max(n + 2, ws.R1S.length * 2);
    ws.R1S = new Float64Array(s); ws.R1J = new Int32Array(s); ws.R2S = new Float64Array(s); ws.R2J = new Int32Array(s);
  }
}
function ensureTB(ws: Work, n: number, w: number): void {
  const need = (n + 1) * (2 * w + 1);
  if (ws.TB1.length < need) ws.TB1 = new Uint8Array(need * 2);
  if (ws.TB2.length < need) ws.TB2 = new Uint8Array(need * 2);
  if (ws.TB3.length < need) ws.TB3 = new Uint8Array(need * 2);
}

// ---- seeding: k-mer hits merged into same-diagonal runs ----------------------------------------------------------
/**
 * Anchors of the oriented read whose codes are at RQ[off .. off+n), restricted to read positions [lo, hi) and (when
 * rLo <= rHi) to anchors starting in the unwrapped reference window [rLo, rHi]. Appends to AQ/AR/AL from `na`.
 */
function collectAnchors(idx: Index, ws: Work, off: number, n: number, lo: number, hi: number, na: number): number {
  const k = idx.k, mask = (1 << (2 * k)) - 1, L = idx.L, circ = idx.circular;
  const { head, next, km } = idx;
  const { RQ, diagLast, diagRun, AQ, AR, AL } = ws;
  const sh = 32 - idx.hbits;
  const start = na;
  let h = 0, valid = 0;
  for (let i = lo; i < hi; i++) {
    const c = RQ[off + i];
    if (c < 0) { valid = 0; h = 0; continue; }
    h = ((h << 2) | c) & mask; valid++;
    if (valid < k) continue;
    const qp = i - k + 1;
    let occ = 0;
    const h0 = head[Math.imul(h, -1640531535) >>> sh];
    for (let p = h0; p >= 0 && occ <= P.maxOcc; p = next[p]) if (km[p] === h) occ++;
    if (occ === 0 || occ > P.maxOcc) continue;
    for (let p = h0; p >= 0; p = next[p]) {
      if (km[p] !== h) continue;
      let d = p - qp;
      if (circ) { d %= L; if (d < 0) d += L; } else d += n;
      if (diagLast[d] === qp - 1 && diagRun[d] >= start) AL[diagRun[d]]++;
      else if (na < MAXA) { AQ[na] = qp; AR[na] = p; AL[na] = k; diagRun[d] = na; na++; }
      diagLast[d] = qp;
    }
  }
  for (let a = start; a < na; a++) {
    let d = AR[a] - AQ[a];
    if (circ) { d %= L; if (d < 0) d += L; } else d += n;
    diagLast[d] = -2;
  }
  return na;
}

// ---- chaining ------------------------------------------------------------------------------------------------
/** Reference advance from a's start to b's start (circular: modulo L, small backward steps negative). */
function refStep(L: number, circ: boolean, ra: number, rb: number): number {
  let x = rb - ra;
  if (circ) { x %= L; if (x < 0) x += L; if (x > L - 64) x -= L; }
  return x;
}
/** Chaining DP over anchors [s, e) (sorted by read position). Returns the best end anchor; CF/CP/COV filled. */
function chain(ws: Work, L: number, circ: boolean, s: number, e: number): number {
  const { AQ, AR, AL, CF, CP, COV, CS } = ws;
  let best = -1, bestF = NEG;
  const wM = P.chainMatch, cap2 = 2 * P.chainGapOpen2;
  const TOPN = 8;
  const top = [-1, -1, -1, -1, -1, -1, -1, -1];
  for (let b = s; b < e; b++) {
    let f = AL[b] * wM, pred = -1, pov = 0, span = AL[b];
    const bq = AQ[b], br = AR[b], bl = AL[b];
    const w0 = Math.max(s, b - P.chainLookback);
    for (let t = -TOPN; t < b - w0; t++) {
      const a = t < 0 ? top[t + TOPN] : w0 + t;
      if (a < 0 || (t < 0 && a >= w0)) continue;
      const adq = bq - AQ[a];
      if (adq <= 0) continue;
      const x = refStep(L, circ, AR[a], br);
      if (x <= 0 || CS[a] + x - AL[a] + bl > L) continue; // a chain never covers more than the plasmid
      const al = AL[a];
      const ov = Math.max(0, al - adq, al - x);
      if (ov >= bl - 4) continue;
      const dq = adq - al + ov, dr = x - al + ov;
      const g = dq > dr ? dq - dr : dr - dq;
      const mn = dq < dr ? dq : dr;
      const v = CF[a] + (bl - ov) * wM - chainGapCost(g) - (mn < cap2 ? mn : cap2);
      if (v > f) { f = v; pred = a; pov = ov; span = CS[a] + x - AL[a] + bl; }
    }
    CF[b] = f; CP[b] = pred; COV[b] = pov; CS[b] = span;
    if (f > bestF) { bestF = f; best = b; }
    let pos = TOPN;
    while (pos > 0 && (top[pos - 1] < 0 || CF[top[pos - 1]] < f)) pos--;
    if (pos < TOPN) { for (let t = TOPN - 1; t > pos; t--) top[t] = top[t - 1]; top[pos] = b; }
  }
  return best;
}

// ---- banded quality-aware Gotoh DP (2-piece affine) -----------------------------------------------------------
// Read bases: dir +1 -> RQ[qs + i - 1] (i = 1..n); dir -1 -> RQ[qs - i]. Reference likewise from ref3[rs ...].
// global: path from (0,0) to (n,m), band around the straight line; else extension from (0,0) with X-drop.
// Traceback bits: 0-2 H source (0 diag, 1 E1, 2 E2, 3 F1, 4 F2, 7 origin), 3 E1ext, 4 E2ext, 5 F1ext, 6 F2ext.
interface DPRes { score: number; i: number; j: number; rows: number; w: number; n: number; m: number; global: boolean }
function bdp(ws: Work, ref3: Int8Array, qs: number, n: number, rs: number, m: number, dir: number, global: boolean, w: number, tb: Uint8Array, rbS: Float64Array, rbJ: Int32Array): DPRes {
  const BW = 2 * w + 1;
  const RQ = ws.RQ, RQQ = ws.RQQ;
  const o1 = P.gapOpen1, e1 = P.gapExt1, o2 = P.gapOpen2, e2 = P.gapExt2;
  let Hp = ws.H0, Hc = ws.H1;
  const F1 = ws.F1, F2 = ws.F2;
  const slope = global && n > 0 ? m / n : 1;
  const q1 = n > 0 ? RQQ[dir > 0 ? qs : qs - 1] : 30;
  const hi0 = Math.min(m, w);
  let E1 = NEG, E2 = NEG;
  Hp[0] = 0; F1[0] = NEG; F2[0] = NEG; tb[w] = 7;
  {
    const d1o = o1 * GQ[q1], d1e = e1 * GQ[q1];
    for (let j = 1; j <= hi0; j++) {
      let bits = 0;
      const hl = Hp[j - 1];
      const a1 = hl - d1o; if (E1 >= a1) { E1 -= d1e; bits |= 8; } else E1 = a1 - d1e;
      const a2 = hl - o2; if (E2 >= a2) { E2 -= e2; bits |= 16; } else E2 = a2 - e2;
      let h = E1, src = 1;
      if (E2 > h) { h = E2; src = 2; }
      Hp[j] = h; F1[j] = NEG; F2[j] = NEG;
      tb[j + w] = src | bits;
    }
  }
  let prevLo = 0, prevHi = hi0;
  let best = 0, bi = 0, bj = 0, rows = n;
  rbS[0] = 0; rbJ[0] = 0;
  const xd = P.xdrop;
  for (let i = 1; i <= n; i++) {
    const qi = dir > 0 ? qs + i - 1 : qs - i;
    const ci = RQ[qi], qv = RQQ[qi];
    const qn = i < n ? RQQ[dir > 0 ? qi + 1 : qi - 1] : qv;
    const qd = qn < qv ? qn : qv;
    const i1o = o1 * GQ[qv], i1e = e1 * GQ[qv], d1o = o1 * GQ[qd], d1e = e1 * GQ[qd];
    const ma = MATCH[qv], mi = MISM[qv];
    const c = global ? Math.round(i * slope) : i;
    const lo = c - w > 0 ? c - w : 0, hi = c + w < m ? c + w : m;
    if (lo > hi) { rows = i - 1; break; }
    const rowOff = i * BW - c + w;
    E1 = NEG; E2 = NEG;
    let rowMax = NEG, rowJ = lo;
    for (let j = lo; j <= hi; j++) {
      let bits = 0;
      if (j > lo) {
        const hl = Hc[j - 1];
        const a1 = hl - d1o; if (E1 >= a1) { E1 -= d1e; bits |= 8; } else E1 = a1 - d1e;
        const a2 = hl - o2; if (E2 >= a2) { E2 -= e2; bits |= 16; } else E2 = a2 - e2;
      }
      let f1 = NEG, f2 = NEG;
      if (j >= prevLo && j <= prevHi) {
        const hu = Hp[j];
        const b1 = hu - i1o, x1 = F1[j];
        if (x1 >= b1) { f1 = x1 - i1e; bits |= 32; } else f1 = b1 - i1e;
        const b2 = hu - o2, x2 = F2[j];
        if (x2 >= b2) { f2 = x2 - e2; bits |= 64; } else f2 = b2 - e2;
      }
      F1[j] = f1; F2[j] = f2;
      let h = NEG, src = 0;
      if (j > 0 && j - 1 >= prevLo && j - 1 <= prevHi) {
        const cj = ref3[dir > 0 ? rs + j - 1 : rs - j];
        h = Hp[j - 1] + (cj === -2 ? NEG : ci < 0 || cj < 0 ? 0 : ci === cj ? ma : mi);
      }
      if (E1 > h) { h = E1; src = 1; }
      if (E2 > h) { h = E2; src = 2; }
      if (f1 > h) { h = f1; src = 3; }
      if (f2 > h) { h = f2; src = 4; }
      Hc[j] = h;
      tb[rowOff + j] = src | bits;
      if (h > rowMax) { rowMax = h; rowJ = j; }
    }
    rbS[i] = rowMax; rbJ[i] = rowJ;
    prevLo = lo; prevHi = hi;
    const t = Hp; Hp = Hc; Hc = t;
    if (!global) {
      if (rowMax > best) { best = rowMax; bi = i; bj = rowJ; }
      if (rowMax < best - xd) { rows = i; break; }
    }
  }
  if (global) return { score: Hp[m], i: n, j: m, rows: n, w, n, m, global };
  return { score: best, i: bi, j: bj, rows, w, n, m, global };
}

/** Traceback from cell (i, j) of a bdp run; pushes ops in traceback order into `out`. */
function traceback(r: DPRes, tb: Uint8Array, i: number, j: number, out: number[]): void {
  const BW = 2 * r.w + 1, slope = r.global && r.n > 0 ? r.m / r.n : 1;
  let state = 0;
  while (i > 0 || j > 0) {
    const c = r.global ? Math.round(i * slope) : i;
    const t = tb[i * BW + j - c + r.w];
    if (state === 0) {
      const src = t & 7;
      if (src === 7) break;
      if (src === 0) { out.push(OP_M); i--; j--; continue; }
      state = src; continue;
    }
    if (state === 1) { out.push(OP_D); state = t & 8 ? 1 : 0; j--; continue; }
    if (state === 2) { out.push(OP_D); state = t & 16 ? 2 : 0; j--; continue; }
    if (state === 3) { out.push(OP_I); state = t & 32 ? 3 : 0; i--; continue; }
    out.push(OP_I); state = t & 64 ? 4 : 0; i--;
  }
}

// ---- alignment of a chain -------------------------------------------------------------------------------------
interface Ctx {
  idx: Index;
  ws: Work;
  off: number; // oriented read at RQ[off .. off+n)
  n: number;
  a: number; // extensions stay inside the oriented clear range [a, b)
  b: number;
  ca: number; // oriented Mott clear range [ca, cb)
  cb: number;
  cq: number[]; cr: number[]; cl: number[]; // chain anchors (read pos, ref pos in [0, L), length)
}
interface Aln { score: number; ops: number[]; qStart: number; rStart: number }

function pushRun(ops: number[], c: number, len: number): void {
  for (let t = 0; t < len; t++) ops.push(c);
}

/** Aligns the oriented read along chain anchors cs..ce, with X-drop extensions at the ends (when asked). */
function buildAln(x: Ctx, cs: number, ce: number, extL: boolean, extR: boolean): Aln {
  const { idx, ws, off, cq, cr, cl } = x;
  const L = idx.L, circular = idx.circular, ref3 = idx.ref3;
  const ops: number[] = [];
  let score = 0;
  const w = P.band;
  const tmp: number[] = [];
  let qStart = cq[cs], rStart = cr[cs];
  const ne0 = cq[cs] - x.a;
  if (extL && ne0 > 0) {
    const me = Math.min(ne0 + w, circular ? L - 1 : cr[cs]);
    if (me > 0) {
      ensureTB(ws, ne0, w); ensureDP(ws, me, ne0);
      const r = bdp(ws, ref3, off + cq[cs], ne0, L + cr[cs], me, -1, false, w, ws.TB1, ws.R1S, ws.R1J);
      traceback(r, ws.TB1, r.i, r.j, tmp);
      for (const c of tmp) ops.push(c); // a backward traceback yields left-to-right order
      score += r.score;
      qStart -= r.i; rStart -= r.j;
    }
  }
  for (let t = cs; t <= ce; t++) {
    if (t > cs) {
      const qe = cq[t - 1] + cl[t - 1], re = cr[t - 1] + cl[t - 1];
      const ga = cq[t] - qe;
      const gb = circular ? (((cr[t] - re) % L) + L) % L : cr[t] - re;
      score += fillGap(x, ops, off + qe, ga, L + (re % L), gb);
    }
    const RQQ = ws.RQQ, base = off + cq[t];
    for (let u = 0; u < cl[t]; u++) { ops.push(OP_M); score += MATCH[RQQ[base + u]]; }
  }
  const qe = cq[ce] + cl[ce], re = cr[ce] + cl[ce];
  const ne1 = x.b - qe;
  if (extR && ne1 > 0) {
    const me = Math.min(ne1 + w, circular ? L - 1 : L - re);
    if (me > 0) {
      ensureTB(ws, ne1, w); ensureDP(ws, me, ne1);
      const r = bdp(ws, ref3, off + qe, ne1, L + (re % L), me, 1, false, w, ws.TB1, ws.R1S, ws.R1J);
      tmp.length = 0;
      traceback(r, ws.TB1, r.i, r.j, tmp);
      for (let u = tmp.length - 1; u >= 0; u--) ops.push(tmp[u]);
      score += r.score;
    }
  }
  return { score, ops, qStart, rStart };
}

/** Aligns read gap [qs, qs+ga) to ref gap [rs, rs+gb) (ref3 coordinates) between two anchors; appends ops; returns the score. */
function fillGap(x: Ctx, ops: number[], qs: number, ga: number, rs: number, gb: number): number {
  if (ga === 0 && gb === 0) return 0;
  if (ga === 0) { pushRun(ops, OP_D, gb); return -gapCost(gb); }
  if (gb === 0) { pushRun(ops, OP_I, ga); return -gapCost(ga); }
  const ws = x.ws, ref3 = x.idx.ref3;
  const d = Math.abs(ga - gb);
  ensureTB(ws, ga, Math.max(d + 8, P.band));
  let bestScore = NEG, mode = 0;
  let gr: DPRes | null = null;
  if (d <= P.globalMaxDiff) {
    const w = d + 8;
    ensureDP(ws, gb, ga);
    gr = bdp(ws, ref3, qs, ga, rs, gb, 1, true, w, ws.TB1, ws.R1S, ws.R1J);
    bestScore = gr.score; mode = 1;
  }
  // split junction: forward extension from the left anchor + backward extension from the right anchor + long I/D
  if (mode === 0 || ga > P.splitMin) {
    const w = P.band;
    const T1 = mode === 1 ? ws.TB2 : ws.TB1; // keep the global traceback in TB1
    const TBR = ws.TB3;
    const mw = Math.min(gb, ga + w);
    ensureDP(ws, mw, ga);
    const lr = bdp(ws, ref3, qs, ga, rs, mw, 1, false, w, T1, ws.R1S, ws.R1J);
    const lrows = lr.rows;
    const LS = ws.R1S.slice(0, lrows + 1), LJ = ws.R1J.slice(0, lrows + 1);
    const rr = bdp(ws, ref3, qs + ga, ga, rs + gb, mw, -1, false, w, TBR, ws.R2S, ws.R2J);
    const rrows = rr.rows, RS = ws.R2S, RJ = ws.R2J;
    let bs = NEG, sI1 = 0, sI2 = 0, sJ1 = 0, sJ2 = 0;
    for (let i1 = 0; i1 <= lrows; i1++) {
      const s1 = LS[i1], j1 = LJ[i1];
      if (s1 < -P.xdrop) continue;
      for (let i2 = 0; i2 <= rrows && i1 + i2 <= ga; i2++) {
        const j2 = RJ[i2];
        if (j1 + j2 > gb) continue;
        const v = s1 + RS[i2] - gapCost(ga - i1 - i2) - gapCost(gb - j1 - j2);
        if (v > bs) { bs = v; sI1 = i1; sJ1 = j1; sI2 = i2; sJ2 = j2; }
      }
    }
    if (bs > bestScore) {
      const tmp: number[] = [];
      traceback(lr, T1, sI1, sJ1, tmp);
      for (let u = tmp.length - 1; u >= 0; u--) ops.push(tmp[u]);
      pushRun(ops, OP_I, ga - sI1 - sI2);
      pushRun(ops, OP_D, gb - sJ1 - sJ2);
      tmp.length = 0;
      traceback(rr, TBR, sI2, sJ2, tmp);
      for (const c of tmp) ops.push(c);
      return bs;
    }
  }
  const tmp: number[] = [];
  traceback(gr as DPRes, ws.TB1, ga, gb, tmp);
  for (let u = tmp.length - 1; u >= 0; u--) ops.push(tmp[u]);
  return bestScore;
}

/** Significance threshold for an alignment of a read of `m` bases (E-value-like: grows with log2 of the search space). */
function threshold(m: number, L: number, cnst: number): number {
  return Math.max(P.minScoreFloor, cnst + Math.log2(Math.max(1, m) * 2 * L));
}

/** True when the link from anchor t-1 to anchor t is a long gap (deletion, insertion or replacement). */
function longLink(x: Ctx, t: number): boolean {
  const L = x.idx.L;
  const qe = x.cq[t - 1] + x.cl[t - 1], re = x.cr[t - 1] + x.cl[t - 1];
  const ga = x.cq[t] - qe, gb = x.idx.circular ? (((x.cr[t] - re) % L) + L) % L : x.cr[t] - re;
  return Math.abs(ga - gb) > 20 || Math.min(ga, gb) > 30;
}

/**
 * Aligns the chain, dropping chain ends attached over a long gap unless they are significant on their own or raise
 * the alignment score.
 */
function alignChain(x: Ctx): Aln {
  let cs = 0, ce = x.cq.length - 1;
  let best = buildAln(x, cs, ce, true, true);
  const L = x.idx.L;
  const segSig = (s0: number, s1: number, left: boolean): boolean => {
    if (!P.flankRule) return false;
    const seg = buildAln(x, s0, s1, left, !left);
    const len = x.cq[s1] + x.cl[s1] - x.cq[s0];
    return seg.score >= threshold(len, L, P.segConst);
  };
  // cut points: the long links, at most MAXCUT from each side
  const MAXCUT = 12;
  for (let improved = true; improved; ) {
    improved = false;
    let bestAlt: Aln | null = null, bt = -1, tried = 0;
    for (let t = cs + 1; t <= ce && tried < MAXCUT; t++) if (longLink(x, t)) {
      tried++;
      const alt = buildAln(x, t, ce, true, true);
      if (!bestAlt || alt.score > bestAlt.score) { bestAlt = alt; bt = t; }
    }
    if (bestAlt && bestAlt.score > best.score && (bestAlt.score > best.score + P.joinSlack || !segSig(cs, bt - 1, true))) {
      best = bestAlt; cs = bt; improved = true;
    }
    bestAlt = null; bt = -1; tried = 0;
    for (let t = ce; t > cs && tried < MAXCUT; t--) if (longLink(x, t)) {
      tried++;
      const alt = buildAln(x, cs, t - 1, true, true);
      if (!bestAlt || alt.score > bestAlt.score) { bestAlt = alt; bt = t; }
    }
    if (bestAlt && bestAlt.score > best.score && (bestAlt.score > best.score + P.joinSlack || !segSig(bt, ce, false))) {
      best = bestAlt; ce = bt - 1; improved = true;
    }
  }
  x.cq = x.cq.slice(cs, ce + 1); x.cr = x.cr.slice(cs, ce + 1); x.cl = x.cl.slice(cs, ce + 1);
  return best;
}

// ---- clipped-end rescue -------------------------------------------------------------------------------------------
/**
 * Re-seeds a clipped read end [lo, hi) of the oriented read with the small-k index and returns the best anchor run
 * (read pos, ref pos, length) that lies colinear on the correct side of the alignment (`left`: ends before the
 * alignment's first base, within one plasmid length), or null.
 */
function rescueSeed(x: Ctx, small: Index, lo: number, hi: number, alnQ: number, alnR: number, left: boolean): [number, number, number] | null {
  const ws = x.ws, L = x.idx.L, circ = x.idx.circular, n = x.n;
  let na = collectAnchors(small, ws, x.off, n, lo, hi, 0);
  let bestLen = 0, bq = -1, br = -1, other = 0;
  for (let a = 0; a < na; a++) {
    const q = ws.AQ[a], r = ws.AR[a], l = ws.AL[a];
    let dr: number; // reference distance between the piece and the alignment, in the read's direction
    if (left) dr = circ ? (((alnR - (r + l)) % L) + L) % L : alnR - (r + l);
    else dr = circ ? (((r - alnR) % L) + L) % L : r - alnR;
    const dq = left ? alnQ - (q + l) : q - alnQ;
    if (dr < 0 || dr > L - 64 || dq < 0) { if (l > other) other = l; continue; }
    if (l > bestLen) { bestLen = l; bq = q; br = r; }
  }
  if (bestLen === 0) return null;
  // the clipped part must not be explained better elsewhere (other strand: an inversion; same strand: a rearrangement)
  na = collectAnchors(small, ws, x.off === 0 ? n : 0, n, n - hi, n - lo, 0);
  for (let a = 0; a < na; a++) if (ws.AL[a] > other) other = ws.AL[a];
  return other > bestLen + P.rescueOtherMargin ? null : [bq, br, bestLen];
}

// ---- driver ----------------------------------------------------------------------------------------------------
export function alignSangerRead(ref: string, circular: boolean, read: SangerReadInput): SangerAlignResult {
  const seq = read.seq ?? '';
  const n = seq.length;
  const none: SangerAlignResult = { aligned: false, strand: 1, refStart: 0, cigar: n ? `${n}S` : '' };
  const L = ref.length;
  const k = L > 65536 ? P.kLarge : P.k;
  if (n < k || L < 2 * k) return none;
  const idx = getIndex(ref, circular, k);
  const ws = idx.ws;
  ensureRead(ws, n, L);
  const RQ = ws.RQ, RQQ = ws.RQQ;
  const qual = read.qual && read.qual.length === n ? read.qual : null;
  for (let i = 0; i < n; i++) {
    const c = CODE[seq.charCodeAt(i) & 127];
    const qv = qual ? Math.min(60, Math.max(0, qual[i] | 0)) : P.defaultQ;
    RQ[i] = c; RQQ[i] = qv;
    RQ[2 * n - 1 - i] = c < 0 ? -1 : COMPC[c]; RQQ[2 * n - 1 - i] = qv;
  }
  // 1. Mott clear range
  let t0 = 0, t1 = n;
  {
    let best = 0, run = 0, runS = 0, bs = 0, be = 0;
    for (let i = 0; i < n; i++) {
      if (run <= 0) { run = 0; runS = i; }
      run += P.mottCutoff - PERR[RQQ[i]];
      if (run > best) { best = run; bs = runS; be = i + 1; }
    }
    if (be - bs >= P.minTrimmed) { t0 = bs; t1 = be; }
  }
  // 2-3. seeds and chains, both strands
  const nF = collectAnchors(idx, ws, 0, n, 0, n, 0);
  const bestF = chain(ws, L, circular, 0, nF);
  const nA = collectAnchors(idx, ws, n, n, 0, n, nF);
  const bestR = chain(ws, L, circular, nF, nA);
  let end = -1, strand: 1 | -1 = 1;
  if (bestF >= 0 && (bestR < 0 || ws.CF[bestF] >= ws.CF[bestR])) end = bestF;
  else if (bestR >= 0) { end = bestR; strand = -1; }
  if (end < 0) return none;
  const off = strand === 1 ? 0 : n;
  const cq: number[] = [], cr: number[] = [], cl: number[] = [];
  {
    const ids: number[] = [];
    for (let e = end; e >= 0; e = ws.CP[e]) ids.push(e);
    for (let t = ids.length - 1; t >= 0; t--) {
      const e = ids[t], ov = t < ids.length - 1 ? ws.COV[e] : 0;
      cq.push(ws.AQ[e] + ov); cr.push((ws.AR[e] + ov) % L); cl.push(ws.AL[e] - ov);
    }
  }
  const ca = strand === 1 ? t0 : n - t1, cb = strand === 1 ? t1 : n - t0;
  const x: Ctx = { idx, ws, off, n, a: P.extendFull ? 0 : ca, b: P.extendFull ? n : cb, ca, cb, cq, cr, cl };
  // 4-5. alignment
  let best = alignChain(x);
  // 6. clipped-end rescue
  if (P.rescue) best = rescue(x, best);
  const score = best.score;
  if (score < threshold(n, L, P.sigConst)) return none;
  if (P.clip) best = clipEnds(x, best);
  return toResult(x, best, strand);
}

/** Re-seeds clipped ends and joins a significant colinear piece with I/D. */
function rescue(x: Ctx, best: Aln): Aln {
  const { idx, n } = x;
  const L = idx.L;
  // read extent of the current alignment
  let qEnd = best.qStart, rEnd = best.rStart;
  for (const c of best.ops) { if (c !== OP_D) qEnd++; if (c !== OP_I) rEnd++; }
  const getSmall = (): Index => (idx.small ??= buildIndex(idx.ref, idx.circular, P.rescueK, idx.ws)); // shares the scratch space
  for (const left of [true, false]) {
    const lo = left ? 0 : qEnd, hi = left ? best.qStart : n;
    // only clipped ends with enough readable bases
    let good = 0;
    for (let i = lo; i < hi; i++) if (x.ws.RQQ[x.off + i] >= 15) good++;
    if (good < P.rescueMin) continue;
    const s = rescueSeed(x, getSmall(), lo, hi, left ? best.qStart : qEnd, left ? best.rStart : idx.circular ? rEnd % L : rEnd, left);
    if (!s) continue;
    // the piece's own alignment: extend the seed both ways inside the clipped end
    const piece: Ctx = { ...x, a: lo, b: hi, cq: [s[0]], cr: [s[1] % L], cl: [s[2]] };
    const own = buildAln(piece, 0, 0, true, true);
    let pLen = 0;
    for (const c of own.ops) if (c !== OP_D) pLen++;
    if (own.score < threshold(pLen, L, P.segConst)) continue;
    // join: re-align with the piece as an extra chain anchor (the fill between them decides the I/D)
    const cq = x.cq.slice(), cr = x.cr.slice(), cl = x.cl.slice();
    if (left) { cq.unshift(s[0]); cr.unshift(s[1] % L); cl.unshift(s[2]); }
    else { cq.push(s[0]); cr.push(s[1] % L); cl.push(s[2]); }
    const y: Ctx = { ...x, a: Math.min(x.a, lo), b: Math.max(x.b, hi), cq, cr, cl };
    const joined = buildAln(y, 0, cq.length - 1, true, true);
    let span = 0;
    for (const c of joined.ops) if (c !== OP_I) span++;
    if (span <= L && joined.score > best.score - P.joinSlack && joined.score > own.score) {
      x.cq = cq; x.cr = cr; x.cl = cl; x.a = y.a; x.b = y.b;
      best = joined;
      qEnd = best.qStart; rEnd = best.rStart;
      for (const c of best.ops) { if (c !== OP_D) qEnd++; if (c !== OP_I) rEnd++; }
    }
  }
  return best;
}

/**
 * Keeps the maximum-scoring stretch of the alignment columns under a quality-blind unit score (snapgene's
 * bestStretch): match +clipMatch, mismatch -clipMis, each gap base -clipGap, one gap costing at most clipGapCap (so a
 * long deletion or insertion between two good flanks survives). Clips noisy ends where indels can no longer be placed.
 * Then drops an end block (the part beyond the outermost gap of >= clipLongGap bases) worth less than clipMinBlock.
 */
function clipEnds(x: Ctx, best: Aln): Aln {
  const { idx, ws, off } = x;
  const L = idx.L, ref3 = idx.ref3, RQ = ws.RQ, ops = best.ops, len = ops.length;
  const circ = idx.circular;
  const col = new Float64Array(len);
  const run = new Int32Array(len); // gap run length at the first op of a run
  let qi = best.qStart, rp = best.rStart;
  for (let u = 0; u < len; ) {
    const c = ops[u];
    if (c === OP_M) {
      const rb = ref3[L + (circ ? (((rp % L) + L) % L) : rp)], qb = RQ[off + qi];
      const out = qi < x.ca || qi >= x.cb;
      col[u] = qb < 0 || rb < 0 ? 0 : qb === rb ? P.clipMatch : out ? -P.clipMisOut : -P.clipMis;
      qi++; rp++; u++;
      continue;
    }
    let w = 1;
    while (u + w < len && ops[u + w] === c) w++;
    const out = qi < x.ca || qi >= x.cb;
    col[u] = -Math.min(P.clipGapCap, (out ? P.clipGapOut : P.clipGap) * w);
    run[u] = w;
    if (c === OP_I) qi += w; else rp += w;
    u += w;
  }
  let sum = 0, bestSum = 0, bs = 0, be = -1, start = 0;
  for (let u = 0; u < len; u++) {
    if (sum <= 0) { sum = 0; start = u; }
    sum += col[u];
    if (sum > bestSum) { bestSum = sum; bs = start; be = u; }
  }
  if (be < 0) return best;
  while (be > bs && ops[be] !== OP_M) be--;
  // weak end blocks beyond a long gap
  for (let changed = true; changed; ) {
    changed = false;
    let acc = 0;
    for (let u = bs; u <= be; u++) {
      if (run[u] >= P.clipLongGap) {
        if (acc < P.clipMinBlock) { bs = u; while (bs <= be && ops[bs] !== OP_M) bs++; changed = true; }
        break;
      }
      acc += col[u];
    }
    acc = 0;
    for (let u = be; u >= bs; u--) {
      if (run[u] >= P.clipLongGap) {
        if (acc < P.clipMinBlock) { be = u; while (be >= bs && ops[be] !== OP_M) be--; changed = true; }
        break;
      }
      acc += col[u];
    }
  }
  if (be < bs) return best;
  if (bs === 0 && be === len - 1) return best;
  let qStart = best.qStart, rStart = best.rStart;
  for (let u = 0; u < bs; u++) { if (ops[u] !== OP_D) qStart++; if (ops[u] !== OP_I) rStart++; }
  return { score: best.score, ops: ops.slice(bs, be + 1), qStart, rStart };
}

/** Normalises gaps, clips to one plasmid length and writes the CIGAR. */
function toResult(x: Ctx, best: Aln, strand: 1 | -1): SangerAlignResult {
  const { idx, n } = x;
  const L = idx.L;
  leftAlignGaps(x, best.ops, best.qStart, best.rStart);
  const ops = absorbJunctionMatches(best.ops);
  let rStart = best.rStart;
  let s = 0, e = ops.length;
  let lead = best.qStart;
  while (s < e && ops[s] !== OP_M) { if (ops[s] === OP_I) lead++; else rStart++; s++; }
  while (e > s && ops[e - 1] !== OP_M) e--;
  // a circular alignment may not span more than the plasmid; a linear one must stay on it
  let span = 0;
  for (let u = s; u < e; u++) {
    if (ops[u] !== OP_I) span++;
    if (span > L) { e = u; break; }
  }
  while (e > s && ops[e - 1] !== OP_M) e--;
  if (s >= e) return { aligned: false, strand: 1, refStart: 0, cigar: `${n}S` };
  let cig = lead ? `${lead}S` : '';
  let run = 0, prev = 0, used = 0;
  for (let u = s; u < e; u++) {
    const c = ops[u];
    if (c !== OP_D) used++;
    if (c === prev) run++;
    else { if (run) cig += run + String.fromCharCode(prev); prev = c; run = 1; }
  }
  if (run) cig += run + String.fromCharCode(prev);
  const trail = n - lead - used;
  if (trail) cig += `${trail}S`;
  return { aligned: true, strand, refStart: ((rStart % L) + L) % L, cigar: cig };
}

/**
 * A few chance-matching bases between two long gaps (e.g. 300I 2M 500D at a replaced insert) are made part of the
 * junction (302I 502D), so a replacement reads as one insertion and one deletion. Returns the (possibly new) op list.
 */
function absorbJunctionMatches(ops: number[]): number[] {
  // runs: [op, length]
  const ro: number[] = [], rl: number[] = [];
  for (const c of ops) {
    if (ro.length && ro[ro.length - 1] === c) rl[rl.length - 1]++;
    else { ro.push(c); rl.push(1); }
  }
  let changed = false;
  for (let k = 1; k + 1 < ro.length; k++) {
    if (ro[k] !== OP_M || rl[k] > 3 || ro[k - 1] === OP_M || ro[k + 1] === OP_M || rl[k - 1] < 20 || rl[k + 1] < 20) continue;
    const m = rl[k];
    // the bases become one more I and one more D; merge with the neighbouring gap runs
    if (ro[k - 1] === ro[k + 1]) { rl[k - 1] += rl[k + 1] + m; ro[k] = ro[k - 1] === OP_I ? OP_D : OP_I; rl[k] = m; ro.splice(k + 1, 1); rl.splice(k + 1, 1); }
    else { rl[k - 1] += m; rl[k + 1] += m; ro.splice(k, 1); rl.splice(k, 1); }
    changed = true;
  }
  if (!changed) return ops;
  const out: number[] = [];
  for (let k = 0; k < ro.length; k++) for (let t = 0; t < rl[k]; t++) out.push(ro[k]);
  return out;
}

/**
 * Shifts each gap left as far as it goes without losing a match (anchors are maximal exact runs and push gaps right,
 * the DP traceback puts them left), from tracy2.
 */
function leftAlignGaps(x: Ctx, ops: number[], qStart: number, rStart: number): void {
  const { idx, ws, off } = x;
  const L = idx.L, circular = idx.circular, ref3 = idx.ref3, RQ = ws.RQ;
  const refAt = (p: number): number => {
    if (circular) return ref3[L + (((p % L) + L) % L)];
    return p >= 0 && p < L ? ref3[L + p] : -2;
  };
  let u = 0, qi = qStart, rp = rStart;
  const len = ops.length;
  while (u < len) {
    const c = ops[u];
    if (c === OP_M) { qi++; rp++; u++; continue; }
    let g = u;
    while (g < len && ops[g] === c) g++;
    const gl = g - u;
    let su = u, sq = qi, sr = rp;
    while (su > 0 && ops[su - 1] === OP_M) {
      const rb = c === OP_D ? RQ[off + sq - 1] : RQ[off + sq - 1 + gl];
      const fb = c === OP_D ? refAt(sr - 1 + gl) : refAt(sr - 1);
      if (rb < 0 || rb !== fb) break;
      ops[su - 1] = c; ops[su - 1 + gl] = OP_M; su--; sq--; sr--;
    }
    if (c === OP_D) rp += gl; else qi += gl;
    u = g;
  }
}
