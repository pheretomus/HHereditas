# core-fix-ops progress log

## Goal
Finish review fixes for module `ops` (packages/core/src/ops/**): for each of the 17 findings in
docs/progress/findings/ops.review-findings.json (indices 0-16) ensure a permanent regression test exists,
then fix the root cause or reject with a precise reason. End with the whole ops suite green and a clean
typecheck for ops files.

## Done so far
- (start) Read _common-core.md, core-ops.md spec, implementer report, review findings (17). No previous
  progress log and no ops.fix-report.json existed.

## Current state
- Establishing baseline (tests + tsc) next.

## Open problems / decisions
- (none yet)

## Next steps
1. Run `npx vitest run src/ops` and `npx tsc --noEmit -p packages/core | grep src/ops`, record results.
2. Map each finding to existing regression tests / code state.
