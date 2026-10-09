# core-fix-gel: progress log

## Goal
Finish the review fixes for module `gel` (packages/core/src/gel/**, plus tools/oracle/gel_* and
packages/core/test/oracle/gel/). For every finding in docs/progress/findings/gel.review-findings.json
(19 findings, several duplicates): permanent regression test + root-cause fix, or a precise rejection.
End state: whole gel suite green, clean typecheck for gel files.

## Done so far
- Read _common-core.md, core-gel.md spec, implementer report, review findings (19 items).
- No predecessor log / gel.fix-report.json existed. A predecessor left failing regression tests (12:47) and an
  exploration of the TBE fit in scratchpad/gelfix/explore*.py (no code fix).
- lane.ts REWRITTEN: complete-linkage grouping (F1/F7/F9), GelBand.fragments (F3/F10), robust relative masses
  (log-space fallback, F4/F11), validated ladder components + no spread-push (F12), error messages naming
  `fragments[i] ('label')` / `ladder 'id' bands[i]` (F6/F13), ladder rows split into components with equal
  mass share (F17).
- ladders.ts: readonly Ladder/LadderBand types (F5/F15); DM003 note 720 -> 740 ng (F19); bandMassAtLoad
  validates ladder.loadNg / band.massNg (F14/F4); Bioneer D-1040/D-1030/D-1020 massNg rescaled to the
  recommended load (F2), loadNg = recommended load (200/200/300; D-1035 320 unchanged).
  F2 source check (done by me): Bioneer PM-338 rev.9 PDF re-downloaded and decoded: "Recommended Loading
  Volume" 2/2/4/2 µl per 5 mm lane (D-1020/1030/1035/1040), 150/100/80/100 ng/µl; tables per 4 or 5 µl.
  Other vendors already consistent: NEB N3232 0.5 µg ("Mass values are for 0.5 µg/gel lane", "We recommend
  loading 0.5 µg"), N3200 1 µg (recommend 0.5-1 µg), N3231 0.5 µg, N3012 1 µg (loading protocol 2 µl of
  500 µg/ml); Thermo GeneRuler 1 µl of 0.5 µg/µl per 5 mm lane; Enzynomics "Recommended loading volume
  5~10 µl" (re-fetched live), tables per 5 µl; Takara "Loading volume is 5 µl per lane".
- migration.ts: table rows deep-frozen (F16).
- ladders.test.ts updated: Bioneer transcription test now checks recommended-load values AND that
  x(table/recommended volume) gives the printed values; readonly test rewritten (see decisions); new tests
  for bandMassAtLoad validation and Enzynomics note totals.

## Current state
- BASELINE (start of this session): `npx vitest run src/gel` -> 19 failed / 83 passed (102 tests, 5 files);
  tsc: no errors in src/gel (other modules have unrelated errors: enzymes, ops, seq).
- NOW: `npx vitest run src/gel` -> 133 passed / 0 failed (5 files); tsc clean for src/gel.
- Grouping algorithm FINAL: agglomerative complete linkage on the line (closest neighbouring runs merged
  first while the union spans < resolution; heap, O(n log n); E. coli MspI 24k fragments ~0.1 s).
  Chosen over a greedy top-down sweep because the sweep splits natural clusters.
- Model FINAL (F8/F18): TAE + TBE <= 1 %: SHAPE_EXPONENT 1.12 / SMALL_DNA_POSITION 0.90 (UNCHANGED,
  reproduced by the original single-shape fit on the 17 original photos); TBE: linear ramp 1 % -> 2 % to
  TBE_HIGH_SHAPE_EXPONENT 1.13 / TBE_HIGH_SMALL_DNA_POSITION 0.86 (stage-2 constrained fit, top >= 0.005).
  Rejected alternative: joint refit (TAE k -> 1.18-1.22) lowers pooled error but compresses 7-10 kb on
  1 % TAE to 0.7x the Thermo photo spacing and merges Invitrogen 8/7 kb at 1 % TAE; reported in
  vendor_gels.json calibration.stage1Refit (adopted: false).
- Oracle regenerated (tools/oracle/gel_oracle.py, deterministic, byte-identical on re-run;
  digests.json + pydna_ladders.json unchanged). vendor_gels.json now has 20 photos, per-photo
  `bestPossible` floor (LR3 3 % TBE: 0.0207, model 0.0213) and a hold-out check (fresh photos predicted
  at 0.021/0.013/0.0075 by the fit without them).

## Duplicate groups (from titles)
- Chaining / single linkage: F1, F7, F9
- labels/sizes traceability: F3, F10
- NaN on validated input: F4, F11, F12, F14
- frozen ladders vs mutable types: F5, F15 (+ F16 constant tables only top-level frozen)
- validation error messages: F6, F13
- Bioneer massNg: F2
- TBE high-% calibration: F8, F18
- NEB 500/517 doublet: F17
- Enzynomics DM003 note total: F19

## Open problems / decisions
- Chaining (F1/F7/F9): replace single linkage by greedy complete linkage (band = fragments within
  `resolution` of the band's top-most fragment). Existing test 'chains neighbours (single linkage)'
  encodes the defect (1000..1145 bp spans 0.026 > 0.01) -> must be rewritten (justified).
- Traceability (F3/F10): add GelBand.fragments (index,size,form,position,label) sorted largest first;
  labels in the same order. Existing exact toEqual test of a single band must include `fragments`.
- F17: split ladder multi-fragment rows into their components (equal mass share, own position) so
  N3200 500/517 and N3232 517+500 give the same mean band. Existing test line
  `d.position === migrate(500)` encodes the inconsistency -> becomes mean of migrate(517), migrate(500).
- F5/F15: readonly Ladder/LadderBand types. Predecessor test 'mutation does not throw' contradicts the
  existing (correct) 'is deeply frozen' test -> rewrite as @ts-expect-error + toThrow(TypeError).
- F2: verify Bioneer PM-338 recommended volumes; scale massNg to the recommended load; check the other
  vendors' recommended loads too.
- F8/F18 (TBE >= 1.7 %): needs a calibration change; research after the lane/ladder fixes.


## F8/F18 research notes (TBE calibration) -- scripts in scratchpad/gelfix2/
- Fresh photos re-measured by me with a NumPy re-implementation of gel_measure_bands.py (tools/measure.py;
  reproduces the implementer's SM1331 rows to 0.01 px): Thermo GeneRuler Low Range MAN0013037 Rev.E00
  (3% agarose, 1X TBE, 5 V/cm 1 h, 8 cm, well visible: origin 16.63; matches reviewer to 0.01 px),
  Thermo GeneRuler 50 bp MAN0013016 Rev.C.00 (2.5% TBE, no well: affine; matches reviewer within 0.2 px),
  NEB N3236 50 bp ladder (3% TBE per product page; affine), 17 bands.
- Root cause: one global shape exponent k = 1.12 is a compromise; TAE photos want ~1.2-1.3, high-% TBE
  photos ~0.9 (with the dye constraints kept). A TBE-specific exponent ramp (k0 at 0.5 % -> k2 at >= 2 %)
  fitted on the ORIGINAL 17 photos predicts the 3 fresh photos out of sample (RMS 0.018/0.007/0.008).
- BUT the unconstrained optimum has a NEGATIVE top asymptote at >= 2 % TBE (long DNA above the well),
  violating the spec (positions 0..1, compression near the top) and the existing test top > 0.
  With the constraint top >= 0: Low Range 3 % TBE abs RMS ~0.021 at best; proven unattainable below 0.0212
  by ANY (k, b) per photo (scan_kb.py) and also by a generalised (Richards) logistic (scan_richards.py);
  the dominant residual is the 25 bp band (-0.04, at the bromophenol blue front: 30 bp at 3 % TBE).
- DECISION (F8/F18): 4 empirical constants. TAE: k = 1.22, b = 0.90 (all %). TBE: k and b linear in agarose %
  from the TAE values at 0.5 % to k = 1.12, b = 0.86 at >= 2 % (knots = dye-table rows, chosen a priori).
  Calibration = least squares over all 20 photos subject to topPosition >= 0.005 for every gel 0.5-3 %
  (spec: positions 0 (well)..1, long DNA compresses near the top), rounded to 2 decimals (top stays > 0:
  min 0.002 at 3 % TBE). Result: pooled RMS 0.0228 -> 0.0116 (20 photos); TBE >= 1.7 % photos all
  <= 0.021 (were 0.034-0.045); 700 bp residual on the 3 % TBE photo +0.079 -> +0.019; 1000/910 bp at
  2.5 % TBE 0.0093 -> 0.015 apart; 1000/900 spacing ratio 0.57 -> 0.83. All existing invariants hold
  (scratchpad/gelfix2/check_invariants2.py).
- Tests that need a justified change: F8 test RMS < 0.02 -> < 0.022 (floor 0.0212 proven for any
  spec-compliant curve of the family; largest residual = 25 bp band at the BPB front) plus new stricter
  checks (700 bp residual < 0.03); oracle stated+wells criterion same exception for that photo;
  reviewer's strict "TBE curve <= TAE curve" on all TBE >= 1.7 % photos -> "<= TAE + 0.01" (noise-limited:
  moving the plateau knot to 1.7 % fixes the 1.7 % photo but the 2.5 % photo then prefers TAE by 0.005).

## Next steps
1. tools/oracle/gel_measure_bands.py: MANIFEST entries for the 3 new photos + NumPy/zlib fallback (no
   SciPy/PyMuPDF needed for them) + `--only`; run with system python3 to verify the stored rows.
2. Review docs (migration.ts header, lane.ts, ladders.ts), final full run + tsc, finalize this log.
