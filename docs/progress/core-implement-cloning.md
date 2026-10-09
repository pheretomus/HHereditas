# core-implement-cloning: progress log

## Goal
Implement `packages/core/src/cloning/**` per `docs/progress/specs/core-cloning.md`: pcr, digestRecord,
endsCompatible, ligate, restrictionClone, gibsonAssembly, designGibsonPrimers, goldenGate, calculators;
pydna oracle (`tools/oracle/cloning_oracle.py`), tests, API doc `docs/progress/api/core-cloning.md`,
`export * from './cloning';` in `packages/core/src/index.ts`.

## Done
- Source: result.ts, digest-record.ts, ligation.ts, pcr.ts, restriction-cloning.ts, gibson.ts
  (gibsonAssembly + designGibsonPrimers + terminalOverlap), golden-gate.ts, calculators.ts, index.ts,
  test-helpers.ts (pure test utilities, not exported).
- Tests: digest-ligation, pcr, restriction-cloning, assembly (Gibson, design self-consistency incl. 25 seeded
  random designs, Golden Gate), calculators, oracle (pydna JSON). 56 tests green.
- Oracle: tools/oracle/cloning_oracle.py -> test/oracle/cloning/{pcr,ligation,gibson,golden_gate}.json
  (150 PCR, 26 restriction cloning, 30 Gibson, 10 Golden Gate cases). All agree.
- Bug found by the oracle and fixed: PCR on a circle where the forward primer's annealing part spans the
  origin (sliceRange start >= L). Regression test in pcr.test.ts.
- `export * from './cloning';` added to packages/core/src/index.ts; full `tsc --noEmit` clean (no name collisions).
- API doc docs/progress/api/core-cloning.md written.

## Design decisions
- One result shape for every operation: `{ product?: SeqRecord; products: SeqRecord[]; warnings: string[]; error?: string }`
  (+ operation-specific fields). Never throws on user-level problems.
- Ligation reuses `ops/concatRecords` (it already merges compatible sticky ends).
- Gibson product = concatRecords with synthetic 5' overhangs of the overlap length on each junction.
- digestRecord: fragments of a circle cut once (parentRange longer than L) are built from an unrolled copy.
- PCR searches both primers in both orientations (as in a real reaction / pydna); non-designated pairings warn.
- Calculators: 650 Da/bp dsDNA (NEBuilder protocol), 330 Da/nt ssDNA.

## Current state
Complete; awaiting review.

## Open problems / limitations
- designGibsonPrimers: circular vectors only; inserts must be >= 18 bp (short inserts belong in tails).
- Golden Gate: exhaustive order search capped at 30 parts.
- Restriction cloning: no dephosphorylation / methylation modelling; insert "auto" choice heuristic documented.

## Next steps
None (review).
