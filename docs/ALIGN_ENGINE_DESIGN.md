# Reference alignment engine — design

Status: superseded. The app now uses `packages/core/src/io/sanger-aligner.ts` (seed – chain – banded quality-aware DP, significance-based acceptance), chosen in a benchmark of eight engines; it covers plasmids and large references alike, and the old `reference-aligner.ts` was removed. This document is kept for its reasoning (trimming, 2-piece gaps, circular folding).

## 1. Decisions

| # | Decision |
|---|---|
| D1 | Plasmid-sized references (R ≤ ~30 kb) are aligned **exactly**: no seeds, a full affine-gap local alignment (Smith-Waterman) of the read against the whole reference. |
| D2 | The usable part of a read is fixed **before** alignment, by Phred-quality trimming (sliding window). The alignment only sees `trimmedRange`; the alignment score does not decide where a read ends. |
| D3 | Large insertions / deletions must not break an alignment: **2-piece affine gap cost** inside the DP, plus **chaining of separate local pieces** for the case where one flank is short. |
| D4 | A circular reference is aligned as `R+R` and the coordinates are folded back modulo `R`. |
| D5 | The SnapGene file is a cross-check, not the target. Its alignments are compared for sanity (same strand, same stretch), never copied. |

## 2. Pipeline

```
read (.ab1 / .scf / ZTR / FASTA / pasted)
   │
   ▼  A. quality trimming            (only when Phred values exist)
trimmedRange = [s, e)
   │
   ▼  B. exact local alignment       both strands, reference R (linear) or R+R (circular)
best piece(s) with 2-piece affine gaps
   │
   ▼  C. chaining of pieces          (large gaps, short flanks)
one chain = one alignment
   │
   ▼  D. fold circular coordinates   pos mod R, aligned span ≤ R
   │
   ▼  E. CIGAR + AlignedSequence     S for trimmed-off / unaligned parts; same record as today
```

The output record and `projectBamAlignment` do not change, so the maps need no change for this.

## 3. A. Quality trimming (D2)

**Input.** Phred values per base:

- `.ab1` (ABIF): tag `PCON` (quality) next to `PBAS` (bases). The reader today returns bases only; it must also return the quality array.
- `.scf`: the quality arrays of the file.
- ZTR (`CNF4`) — also what SnapGene embeds in its `.dna` (packet `0x10` → `0x12`). The sample file has five such reads.
- FASTA / pasted text: no quality → no trimming (`trimmedRange` = whole read); the user can still trim by hand (`manuallyTrimmed`).

**Algorithm** (modified Mott, the one in `docs/SNAPGENE_ALIGN_ARCHITECTURE.md` §3.3):

1. `score[i] = P_limit − 10^(−Q_i/10)`; a base counts as positive only above the stringency's quality threshold.
2. Window `W = min(N, 25)`; for a trace, the anchor window is searched in the first 800 bases.
3. The window with the largest sum gives the anchor (its midpoint); extend left and right to the ends that maximise the cumulative sum; keep the range if its sum > 0, otherwise the read is empty.

| Stringency | P_limit | Phred threshold |
|---|---|---|
| Low | 0.2 | Q ≥ 7 |
| **Medium (default)** | 0.1 | Q ≥ 11 |
| High | 0.05 | Q ≥ 14 |

(The other levels of the document — Lowest, Lower, Higher, Highest — are the same function with another `P_limit`.)

**Effect on the display.** Bases outside `trimmedRange` are not aligned; they become soft clips and are drawn as the dotted tails, as today.

**Difference from SnapGene (known).** In the sample file SnapGene aligned *past* its own `trimmedRange` (read 1: 22 bases to the left; read 0: about 13 to the right). Here the trimmed range is final, as requested.

## 4. B. Exact local alignment (D1)

- Both orientations are aligned; the better score wins (ties: the strand with the lower start).
- Scoring: match +1, mismatch −2, `N` −1, IUPAC-compatible 0. Scores are kept as integers (×10 internally, see §5).
- Three passes, so that memory stays small:
  1. **Fill, score only**, one row at a time → best score and its end cell `(i*, j*)`.
  2. **Reverse fill** on the prefix before `(i*, j*)`, reversed → start cell.
  3. **Traceback** on the small window between start and end (full matrices of that window only).
- Speed, measured here with a plain TypeScript typed-array loop: **about 200 M cells/s** (1.4 kb read × 6.7 kb reference = 50 ms per orientation; × 13.5 kb for a circular reference = 93 ms). Both orientations of a typical circular plasmid: about 0.2 s.
- Size gate: `cells = |read| × |R'|` (R' = `R` or `2R`) ≤ about 300 M → exact (≈ 1.5 s worst case). Above it → the existing seeded aligner (`reference-aligner.ts`).
- Later, if needed: the same three passes in WebAssembly SIMD (parasail-style striped). Not required for plasmids.

## 5. C. Large indels (D3) — what was measured

Synthetic reads cut from the sample reference (1 % substitutions), aligned with parasail (Smith-Waterman, open 3 / extend 1) and minimap2:

| Case | parasail SW | minimap2 map-ont | minimap2 sr |
|---|---|---|---|
| 150 bp deletion, flanks 400 / 400 | one alignment, deletion kept | one alignment | split in 2 |
| 150 bp deletion, flanks 400 / 60 | **60-base flank dropped** | **dropped** | split in 2 |
| 300 bp deletion, flanks 400 / 100 | **100-base flank dropped** | **dropped** | split in 2 |
| 250 bp insertion, flanks 400 / 400 | one alignment, insertion kept | one alignment | split in 2 |
| 250 bp insertion, flanks 400 / 60 | **60-base flank dropped** | **dropped** | split in 2 |

So a plain SW alignment survives a large gap only when the shorter flank pays for it: a 150 bp gap costs 3 + 150 = 153 points, and a flank of 60 bases earns about 60. That is the break to avoid.

Two measures, both:

1. **2-piece affine gap cost** inside the DP (two gap states per direction, like minimap2/ksw2): a gap of length `k` costs `min(o1 + e1·k, o2 + e2·k)`. Proposed (to be tuned on the tests below): `o1 = 3, e1 = 1` (short indels as now), `o2 = 30, e2 = 0.1` (long gaps: 150 → 45, 300 → 60). Integer scores ×10 keep it in `Int16`.
2. **Piece chaining** for what the DP still drops: after the best piece, mask it, find further local pieces in the rest of the read (length ≥ 20, score above a floor), and chain pieces that are collinear (same strand, query and reference both increasing) when `piece score > gap cost` with a concave gap cost (minimap2-style, logarithmic in the gap difference). A chain is written as **one** alignment: pieces as `M`, the junction as `I` and/or `D` (a junction with both gaps nonzero becomes `I` + `D`, as SnapGene itself writes in the sample's read 4).

Maximum reference jump between chained pieces: `min(1000 × query gap, R)` for a circular reference, the same bound as the document's chaining rule.

## 6. D. Circular references (D4)

- Reference for the DP: `R + R` (a read that crosses position 0 is then one contiguous stretch).
- A hit that starts in `[0, R)` is kept; the same hit one copy further on (`start ≥ R`) is its duplicate and is folded: `pos = start mod R`.
- The aligned reference span is capped at `R` (a read cannot go round the plasmid more than once).
- Chaining runs on the doubled coordinates, so a chain that crosses the origin is not special.
- Cost: twice the cells (included in the timings of §4).

## 7. Modules

| File | Role |
|---|---|
| `io/trace-quality.ts` (new) | Phred arrays from ABIF `PCON`, SCF, ZTR `CNF4`. |
| `seq/trim.ts` (new) | Modified-Mott trimming, stringency table. |
| `io/local-align.ts` (new) | Three-pass exact local alignment with 2-piece affine gaps. |
| `io/align-chain.ts` (new) | Multi-piece search and chaining. |
| `io/align-engine.ts` (new) | Orchestration, circular folding, size gate, `AlignedSequence` output. |
| `io/reference-aligner.ts` | Kept: the seeded path for large references. |
| `io/snapgene-alignments.ts` | `alignSequenceToReference` calls the engine; the `.dna` reader/writer is unchanged. |

`AlignSequenceInput` gains `quality?: number[]` and `stringency?: 'low' | 'medium' | 'high'`.

## 8. Verification plan

1. **Trimming vs. the sample.** The five embedded ZTR traces give Phred values; the trimmed ranges SnapGene stored (`228..1381`, `28..1190`, `120..1285`, `16..1177`, `20..444`) are the check. Target: within a few bases at both ends (Medium stringency). This needs the ZTR `CNF4` reader first.
2. **Alignment vs. other tools.** The five reads against parasail and minimap2 (the benchmark in the scratchpad): same strand; reference ends equal to what the trimmed range implies.
3. **Large-indel suite** (the table of §5, automated): deletions 50 / 150 / 300 and insertions 50 / 250 bp with flanks 400, 100, 80, 60, 40 → **one** alignment record with the gap. The smallest flank that still joins is reported; it is the tuning target for `o2 / e2`.
4. **Circular**: reads crossing 0 in both orientations, a read ending exactly at `R`, a read longer than `R`.
5. **Speed**: ≤ 0.5 s for a 1.5 kb read against a 7 kb circular reference (both orientations, TypeScript); budget table for 20 / 30 kb.
6. **No regression**: existing tests; the sample's five reads still land on the same strand and stretch as now.

## 9. Open points

- Default stringency (Medium proposed, as SnapGene's default).
- Whether trimmed-off bases that would have matched should be offered as a user-extendable range (SnapGene shows them as aligned).
- ABIF/SCF variants: only files with a `PCON` / quality block can be trimmed; others fall back to "no trimming".
- WASM SIMD only if a use case needs references above the size gate with exact alignment.
