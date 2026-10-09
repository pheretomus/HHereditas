# Stabilize tests (packages/core + packages/viewer)

## Goal
Make core (src/enzymes src/io src/ops src/primers src/seq src/gel) and viewer test suites green by fixing root causes. No API changes; do not touch core/src/cloning or apps/desktop.

## Done
- Baseline run (2026-10-09): core 4 failed / 1372 passed — all 4 are 5000 ms timeouts (digest pUC19 strand pairs, snapgene 300 round-trips, ops 5 Mbp large, ops insertBases property). tm.test.ts passed.
- viewer 3 failed / 378 passed: GelView lane descriptions, format formatGelSize ladder ('1,517 bp' vs '1.5 kb'), LinearMap glide zoom.

## Current state
DONE. core (enzymes io ops primers seq gel): 50 files / 1376 tests green; with test/ (incl. test/oracle/cloning, owned by core-cloning): 1432 green (3 transient failures in cloning oracle tests seen once while that agent was editing). viewer: 19 files / 381 green, repeated twice under parallel load. tsc --noEmit clean for core and viewer.

## Next steps
- None. Possible future flakes: core primers perf tests with absolute budgets (1 s / 3 s) — passed under load here.

## Fixes (log)
- core snapgene-write 300 round-trips: 2.5 of 3.2 s was `expect(Uint8Array).toEqual` (Vitest walks typed arrays element-wise). Replaced by a firstByteDifference helper (-1 expected) → 0.37 s.
- core timeouts (digest pUC19 pairs 2.5 s, ops 5 Mbp 2 s, ops insertBases property 1.6 s idle): profiled; code under test is a small share (insertBases 142 ms of 1.8 s; ops 315 ms of 2 s; digest ≈58 µs/digest × 36k digests). Load flake → packages/core/vitest.config.ts testTimeout 30 s (perf budgets stay asserted inside tests).
- viewer format.test ladder: test stale vs. ui-fix-gel D15 decision (ladder sizes exact unless lossless). Updated expectations.
- viewer GelView aria-label: test stale vs. D9 (doublets '221/220 bp'). Updated.
- viewer LinearMap glide: root cause = rAF timestamp (jsdom clock from window creation) mixed with global performance.now() (Node clock) → glide stalled by the clock offset (grows under load). Component now uses performance.now() on both ends.
- viewer gel/layout.test (new flake seen under parallel load: 4.6 Mb hit-test budget 100 ms vs ~5 ms idle): timing budgets now use fastestOf3 (best of 3 runs) in both smear and 4.6 Mb tests; budgets unchanged.
