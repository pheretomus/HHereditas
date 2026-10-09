# core-verify-primers — progress log

## Goal
Final verification of module `primers` (packages/core/src/primers) with fresh eyes:
1. run the primers tests and the typecheck;
2. read the source end to end against docs/progress/specs/core-primers.md;
3. independently probe the riskiest behaviours (fresh inputs, oracle comparisons), promote valuable probes;
4. fix every provable defect with a regression test;
5. write the integrator API summary to docs/progress/api/core-primers.md.

## Done so far
- (start) Read _common-core.md, core-primers.md spec, implementer report, core-fix-primers.md, all 16 review
  findings. No predecessor verifier log existed.
- Baseline: `npx vitest run src/primers` → 5 files, 124 tests pass (3 s). `npx tsc --noEmit -p packages/core` →
  exit 0, no errors anywhere.
- Read end to end: index.ts, normalize.ts, tm.ts, thermo-tables.ts, tm-extremes.ts, binding.ts, design.ts,
  analysis.ts, thal.ts (dimer pruning bound LOOP_G37_MIN checked by hand: valid lower bound per loop shape).
- Probes (temp files test/review-tmp/primers-verify-*.test.ts; generators in the session scratchpad, not the repo):
  - binding vs an independent TS reference (own IUPAC tables): 2500 random cases with junk/lowercase/U template
    chars, IUPAC on both sides, tiny circles (L 1–30), extreme options, Tm checked: 15 646 sites (625 mismatched,
    162 across the origin, 3869 Tm) all identical. findAll/scan merge = per-primer union: OK (200 cases).
  - tm vs primer3 calc_tm, 5070 fresh cases (3 methods, mv 0–1000, Mg 0–20, dNTP 0–5, oligo 0.1 nM–10 µM, DMSO,
    formamide, max_nn_length 0–120): max |Δ| 1.0e-6 °C, explained: primer3-py rounds dmso_conc/dmso_fact to float32
    (verified: float32-rounded inputs reproduce primer3 exactly). 'owczarzy2008' vs Biopython saltcorr=7, 2859 fresh
    cases incl. mv = 0 and Mg <= dNTP: max 5.7e-13 °C.
  - thal vs primer3 live, 1800 fresh cases (hairpin 500, homodimer 400, heterodimer 450, end stability 450; long
    partners up to 2.5 kb incl. low complexity, IUPAC codes, maxLoop 0–30, temperature −5–95 °C): 0 differences
    (rel. 1e-9) except 5 documented end1 deviations (3' base without a partner).

## Current state
- Tests 124/124 green, typecheck clean (baseline, before any change of mine).

## Open problems / decisions
- none yet

## Next steps
- Probe (temp tests under packages/core/test/review-tmp/primers-verify-*.test.ts):
  1. binding vs an independent brute-force reference (IUPAC both sides, circular/origin, small L, options grid);
  2. tmRange/tmExtremes vs exhaustive enumeration (> 4096 expansions, all salt methods, formamide);
  3. tm vs primer3/Biopython live on fresh grids; 4. thal vs primer3 live on fresh inputs (long partners,
  maxLoop, temperature); 5. design properties; 6. perf targets; 7. edge cases.
- Then write docs/progress/api/core-primers.md.
