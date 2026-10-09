# core-fix-primers — progress log

## Goal
Finish the review fixes for module `primers` (packages/core/src/primers): for each of the 16 findings in
docs/progress/findings/primers.review-findings.json ensure a permanent regression test exists, then fix the root
cause or reject with a precise reason. End with the whole primers suite green and a clean typecheck for primers files.

## Status: DONE (2026-10-08, ~22:35 KST)
- `npx vitest run src/primers` → 5 files, **124 tests, all pass** (baseline at start: 114, all passing).
- `npx tsc --noEmit -p packages/core` → **0 errors in src/primers** (errors elsewhere belong to other agents:
  enzymes/search.test.ts, enzymes/sets.test.ts, ops/ops.regression.test.ts, seq/search.test.ts,
  test/review-tmp/enzymes-verify-p3.test.ts).
- `tools/oracle/primers_oracle.py` regenerates tm.json, binding.json and thal.json byte-identically (checked twice);
  every pre-existing oracle row is unchanged (new rows come from separate RNGs).
- Temporary files test/review-tmp/primers-fix-* deleted.

## Starting point
- No earlier fix report or progress log existed. Predecessor edits were committed in HEAD (b18e327): normalize.ts and
  tm-extremes.ts plus regression tests for findings 1–10; all 114 tests passed; no half-applied edits were found
  (the oracle script reproduced the committed JSON byte for byte). Findings 1–10 were re-verified with the reviewers'
  exact repro code (temp test), findings 11–16 reproduced as open.

## Per finding
| # | finding | outcome | regression tests |
|---|---|---|---|
| 1, 7 | binding: RNA template U never matches | already fixed (predecessor: normalize.canonicalTemplate); verified with the reviewers' repros | binding.test.ts 'templates as stored in RNA records…' |
| 2, 8 | designPrimer on RNA: U primers + false ambiguity warning | already fixed (predecessor); verified | design.test.ts 'designPrimer review regressions' |
| 3 | toUpperCase before validation (ß/ſ/ﬅ/ﬆ) | already fixed (predecessor: normalize.canonicalOligo); verified | tm/analysis/binding tests |
| 4 | design warning misreports searched lengths | already fixed (predecessor); verified | design.test.ts |
| 5 | designPrimer quadratic, maxLength unbounded | already fixed (predecessor: MAX_DESIGN_PRIMER_LENGTH = 1000; primer3's MAX_PRIMER_LENGTH 36 checked in libprimer3.c) | design.test.ts |
| 6 | tmRange sampled min/max off by up to 2.5 °C | already fixed (predecessor: tm-extremes.ts, exact); verified | tm.test.ts degenerate section |
| 9 | G/C clamp leaves the ±2.5 °C window | already fixed (predecessor); verified | design.test.ts |
| 10 | endStability found=true with unpaired 3' base | already fixed (predecessor: end1 → no structure, documented deviation from primer3) | analysis.test.ts |
| 11 | maxMismatches >= 1 absorbs a tail through chance matches | FIXED in this run | binding.test.ts (oracle, property, dedicated test) |
| 12 | findAllBindingSites all-or-nothing | FIXED in this run: scanBindingSites + documented contract | binding.test.ts |
| 13 | analyzePrimer validates options only <= 60 nt | FIXED in this run | analysis.test.ts |
| 14 | thal heterodimer 60 × 10 000 nt took 9–16 s | FIXED in this run: ~0.65 s, results unchanged | analysis.test.ts + extended thal oracle |
| 15 | degenerate 3' anchor + mismatches: 2–3.5 s on the genome | FIXED in this run: pigeonhole seeds | binding.test.ts (synthetic 4.6 Mb, genome, exhaustive-scan property) |
| 16 | owczarzy2008 throws 'no free cations' (mono = 0, Mg <= dNTP) | FIXED in this run | tm.test.ts (Biopython oracle rows), analysis.test.ts |

## Details of this run's fixes
- **16** tm.ts `resolveTmConditions` depends on the method: 'owczarzy2008' only needs monovalent > 0 or Mg2+ > 0,
  because its Ka model always leaves some Mg2+ free; the primer3 methods still report 'no free cations'. Code that
  uses primer3's Na+ equivalent (the GC% formula above nnMaxLength, thermo() and the structure model) throws an
  explicit RangeError when it is 0. Oracle: tm.json `biopythonNoMonovalent` (300 Biopython saltcorr=7 rows with
  mv = 0, 128 of them with dNTP >= Mg2+).
- **13** analysis.ts `analyzePrimer` calls thalConditions before the length check, and thalConditions rejects a Na+
  equivalent of 0.
- **12** binding.ts `scanBindingSites(template, topology, primers, options?) → { sites, failures: {primerId, message}[] }`,
  exported with the types BindingScan and PrimerBindingFailure. `findAllBindingSites` keeps the PrimerBindingSite[]
  return type the spec requires; its TSDoc now says it is all or nothing and points to scanBindingSites. The
  reviewer's literal repro expects findAllBindingSites itself not to throw. It still fails, on purpose: silently
  dropping a failing primer would hide that primer.
- **11** binding.ts: the walk is unchanged (isolated mismatches, each followed by 2 matches, within the budget). The
  region now ends at the first peak of matches − 3 × mismatches (MISMATCH_COST = 3), so a single mismatch needs at least
  4 matches beyond it. The rationale comes from the SantaLucia & Hicks 2004 tables in primer3_config: an internal
  mismatch has ΔΔG37 of +3.7 kcal/mol on average (median 3.5, 10–90 % range 2.4–5.2, n = 188), and a Watson–Crick stack
  averages −1.41 kcal/mol. Extending through a mismatch plus r matches gains about 3.7 − 1.41(r+1): −0.6 for r = 2,
  −2.0 for r = 3, −3.4 for r = 4.
  - The Python oracle now uses a declarative reference: it enumerates the valid prefixes and takes the best score.
  - Added 64 tail-boundary oracle cases.
  - Of the 332 existing cases, 17 changed sites, as expected.
  - With MISMATCH_COST = 0 (the old behaviour), 3 tests fail.
- **15** binding.ts `planSeeds` picks the seed plan:
  - m = 0: the whole window must match exactly.
  - m >= 1: the better of the anchor alone and a pigeonhole split of [anchor, window) into m+1 parts. The first part
    is joined to the anchor, and the split is chosen by dynamic programming.
  - N's are trimmed from the seed ends, so a plain substring search replaces the regex.
  - If the expected rate is above 1/2, the search makes one direct pass over all positions instead.
  - The walk wraps with one comparison instead of mod().

  Genome timings, before → after (ms):

  | primer | before | after |
  |---|---|---|
  | FR26RV-N, mm 1 | 1972 | ~110 |
  | FR26RV-N, mm 2 | 1906 | ~260–400 |
  | 'ACGATCGGATCCTTAGNNNNN', mm 1 | 1547 | ~45 |

  Coverage: 80 degenerate-3'-end oracle cases and a permanent property test of 600 random cases against an
  exhaustive scan. A temporary stress test of 4000 cases (113 K sites) matched exactly.
- **14** thal.ts fillDimer:
  - rightEnd is computed once per cell. Before, it was computed again for every loop tried.
  - dimerLoop no longer allocates.
  - Exact pruning: an inner pair is skipped when g37[p] + LOOP_G37_MIN ≥ g37(cell) + 1e-3 cal/mol. LOOP_G37_MIN is the
    least ΔG37 of each loop shape, and the helix-end term is common to both sides.
  - Loops longer than 30 nt are skipped; they have NaN energies and were never accepted anyway.

  Results are bit-identical to the unpruned code and to HEAD thal.ts on 12 000 cases (both modes, maxLoop 0–40).
  thal.json gained 40 cases with long low-complexity partners; all agree with primer3 exactly.

  | case | before (ms) | after (ms) | primer3-py (ms) |
  |---|---|---|---|
  | G60 × C10k | 8500–9000 | ~650 | 3071 |
  | random 60 × 10k | 1042 | ~230 | 473 |

  The analysis.ts module docs gained a Cost paragraph.

## Remaining concerns
- The binding-site Tm still ignores mismatches, so it is an upper bound (documented). Including them would need
  nearest-neighbour mismatch parameters in tm().
- The performance tests use absolute bounds: 1 s for the 4.6 Mb template, 3 s for the thal worst case. Margins on
  this i9 are 2.5–5×; a slow CI runner could get close.
- thal.ts and thal-tables.ts are still derived from primer3, which is GPL-2.0-or-later. The licensing decision from
  the implementer report is still open.
- A stray file `packages/core/=` exists. It was not created by this run and is outside primers ownership; it should
  be deleted by its owner.

## Next steps
- None for this module. The integrator should export the primers barrel (including scanBindingSites) from
  packages/core/src/index.ts.
