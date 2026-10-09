# core-fix-enzymes: progress log

STATUS: FINISHED (22:05). All 10 review findings handled; enzymes suite 135/135 green; tsc clean for enzymes files.

## Goal
Finish the review fixes for module `enzymes` (packages/core/src/enzymes/**).
Inputs: spec docs/progress/specs/core-enzymes.md, implementer report, review findings
(docs/progress/findings/enzymes.review-findings.json, 10 findings), earlier fix report
(docs/progress/findings/enzymes.fix-report.json, claimed findings 1-6 fixed, 122 tests).
For every finding: permanent regression test + root-cause fix, or a precise rejection.

## Final status per finding
| # | Finding | Status | Regression tests |
|---|---------|--------|------------------|
| 1 | identical breaks merged before sticky-end check (EcoRI+BsmBI, MlyI, BsaI+BsmAI) | already fixed (predecessor) | digest.test.ts 'regression: identical breaks are validated per recognition site before merging' (3) + first-principles model |
| 2 | conflict tie-break by `top` instead of enzyme name (ApaI vs PspOMI) | already fixed | 'regression: conflicts between identical cut zones are resolved by enzyme name' (2) |
| 3 | same root cause as 1 (BsaI+BsmAI, MlyI twin at 1 with 2-nt overhang) | already fixed | same block as 1 (MlyI both variants) |
| 4 | conflict resolution depends on strand (pUC19 vs revcomp) | already fixed | 'regression: conflict resolution does not depend on the strand' (5) + symmetry properties |
| 5 | nonCutters returns enzymes not in the list | already fixed | sets.test.ts 'regression: cutter lists given an enzyme list only name enzymes of that list' (2) |
| 6 | ends covering the whole molecule accepted | already fixed | 'regression: input ends must leave at least one base pair' (2) |
| 7 | map/cut counts ignore sticky ends | FIXED (this session) | search.test.ts 'review: findSites applies the sticky-end rule of digest...' (4), sets.test.ts 'review: cutter lists of a sticky-ended linear record' (1) |
| 8 | digestSizes can't tell uncut plasmid from linear | FIXED via new API; reviewer test adjusted per spec (see below) | digest.test.ts 'review: gel-lane sizes tell an uncut plasmid from a linear molecule' (2) |
| 9 | shared/frozen result objects | FIXED (this session) | digest.test.ts 'review: digest results are fresh objects that callers may modify' (4) |
| 10 | -0 circular cut positions | FIXED (this session) | search.test.ts 'review: circular cut positions are never negative zero' (2) |

## What was changed (this session)
- NEW src/enzymes/ends.ts (internal, not re-exported): END_KINDS, BLUNT_ENDS (internal default, never
  returned), checkEnds (moved verbatim from digest.ts, same error messages), endBoundary (moved),
  pairedRegion(ends, L) -> {from, to}, linearEndProblem(top, bottom, siteStart, siteEnd, paired) ->
  'cut' | 'site' | undefined. Single source of the linear end rule for search and digest (F7).
- search.ts: `findSites(seq, topology, enzymes, options: SiteSearchOptions = {})` and
  `findSitesForEnzyme(..., options)`; `SiteSearchOptions { ends?: FragmentEnds }`. Linear events filtered with
  linearEndProblem (blunt default == the old Biopython [1, L-1] rule, so existing callers are unaffected);
  ends validated like digest; ignored for circular molecules and ''. Internal `circularGap(x, L)` = mod()
  without -0, used for circular cut positions (F10). File comment updated.
- digest.ts: uses ends.ts (digestDetailed validates ends, then scans; digestLinear gets `paired`);
  toCut / skip site start / circular parentRange start via circularGap; uncut circle gets fresh blunt ends;
  makeFragment copies DigestCut per use; reportConflict builds a new blockedBy per skipped event (F9).
  New `DigestSize { size, topology }` + `digestSizesWithTopology(...)` (largest first, ties in parent order);
  `digestSizes` keeps the spec's number[] and its TSDoc points gel code to the new helper (F8).
  File comment: rule shared with findSites; every result object is new.
- index.ts: exports SiteSearchOptions, digestSizesWithTopology, DigestSize. sets.ts: comment on sticky ends.

## Test changes that needed justification
- F8: predecessor's verbatim reviewer test `expect(digestSizes(circ,[NotI])).not.toEqual(digestSizes(lin,[]))`
  contradicts the spec (`digestSizes(...) -> number[] fragment lengths`): both molecules are 2006 bases, so
  [2006] is the only spec-correct value for both. The reviewer accepted "or the docs point gel code to
  digest() topology". Replaced by tests asserting the new helper distinguishes uncut / linear / linearized
  (also on pUC19) and pinning digestSizes to the spec, plus a seeded property test.
- search.test.ts bruteForceSites reference used the shared mod() and therefore EXPECTED -0 (BsmFI on
  circular CGGTCC), i.e. it encoded finding 10's defect. Now wraps with ((x % L) + L) % L (+0): stricter
  and independent of the implementation.
- F8 random test initially compared against digestSizes (tautological after the refactor); now compares
  sizes and digestSizes against independently sorted digest() lengths.

## Verification
- `npx vitest run src/enzymes`: 135/135 (digest 48, enzyme 25, live-oracle 3, oracle 10, search 37, sets 12), ~4.5 s.
  Baseline at session start: 12 failed / 122 passed (134).
- `npx tsc --noEmit -p .`: 0 errors in enzymes files (baseline 12 x TS2554 in tests). Remaining errors belong to
  other agents: seq/search.test.ts (19), seq/stats.test.ts (1), ops/ops.regression.test.ts (1).
- src/ops/ops.regression.test.ts (only other importer of enzymes) passes 16/16. Viewer uses only types.
- tools/oracle/enzymes_oracle.py and enzymes_generate.py regenerate all 8 JSON files and data.ts
  byte-identically (sha256 checked). Removed predecessor's gitignored tools/oracle/__pycache__/enzymes_*.pyc.
- No temp test files were created (test/review-tmp/ does not exist). No git operations, no installs.

## Remaining concerns / notes for the integrator
- UI: pass `record.ends` to findSites for linear records (`findSites(seq, 'linear', enzymes, { ends })`),
  otherwise sites inside overhangs appear as cutters; use digestSizesWithTopology (or digest()'s
  `topology`) for gel lanes and map 'circular' (uncut) to gel form 'supercoiled' (+ optionally 'nicked').
- DigestFragment.length / digest sizes are full duplex extents including overhangs (EcoRI-linearized pUC19 =
  2690, SnapGene/NEB say 2686 bp). Pre-existing, documented, not raised by the review; may surprise users in
  fragment tables. Decision for the spec owner.
- Pre-existing known limitations unchanged: no Dam/Dcm/CpG blocking, conflict rule is an approximation.
