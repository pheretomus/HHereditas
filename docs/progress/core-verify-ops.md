# core-verify-ops progress log

## Goal
Final verification of module `ops` (packages/core/src/ops/**) with fresh eyes:
1. run the ops tests and the typecheck;
2. read the source end to end against docs/progress/specs/core-ops.md;
3. independently probe the riskiest behaviours (quick tests / oracle comparisons on fresh inputs),
   promote valuable probes to permanent tests;
4. fix every provable defect with a regression test;
5. write the integrator API summary to docs/progress/api/core-ops.md.

## Done so far
- Read _common-core.md, core-ops.md spec, implementer report, core-fix-ops.md (fix pass log).

## Current state
- Not yet run.

## Open problems / decisions
- (none yet)

## Next steps
- Read review findings JSON, run `npx vitest run src/ops` and tsc, then read the source.
