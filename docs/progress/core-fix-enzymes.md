# core-fix-enzymes: progress log

## Goal
Finish the review fixes for module `enzymes` (packages/core/src/enzymes/**).
Inputs: spec docs/progress/specs/core-enzymes.md, implementer report, review findings
(docs/progress/findings/enzymes.review-findings.json, 10 findings), earlier fix report
(docs/progress/findings/enzymes.fix-report.json, claims findings 1-6 fixed, 122 tests).
For every finding: permanent regression test + root-cause fix, or a precise rejection.
End state: whole enzymes suite green, clean typecheck for enzymes files.

## Done so far
- Read _common-core.md, spec, implementer report, fix report, review findings.
- No predecessor progress log existed (this file is new).

## Current state
- (establishing baseline: tests + typecheck next)

## Open problems / decisions
- Findings 7-10 are not mentioned in the earlier fix report: status unknown until code is inspected.

## Next steps
1. Run `npx vitest run src/enzymes` and `npx tsc --noEmit -p .` in packages/core; record results.
2. Check each finding against current code (grep tests for regressions already added).
