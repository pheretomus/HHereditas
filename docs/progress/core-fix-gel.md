# core-fix-gel: progress log

## Goal
Finish the review fixes for module `gel` (packages/core/src/gel/**, plus tools/oracle/gel_* and
packages/core/test/oracle/gel/). For every finding in docs/progress/findings/gel.review-findings.json
(19 findings, several duplicates): permanent regression test + root-cause fix, or a precise rejection.
End state: whole gel suite green, clean typecheck for gel files.

## Done so far
- Read _common-core.md, core-gel.md spec, implementer report, review findings list (19 items).
- No predecessor log and no gel.fix-report.json existed when this log was created.
- File timestamps suggest a predecessor edited ladders.test.ts, lane.test.ts, oracle.test.ts (12:47)
  without touching ladders.ts / lane.ts / migration.ts (11:5x): presumed "tests without fix".

## Current state
- (pending) baseline test run + typecheck.

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
- (none yet)

## Next steps
1. Baseline: npx vitest run src/gel ; npx tsc --noEmit -p packages/core (filter to src/gel).
2. Read each finding in full; inspect the predecessor's added tests.
