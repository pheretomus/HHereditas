# core-fix-snapgene progress log

## Goal
Finish the review fixes for module "snapgene" (packages/core/src/io/snapgene*.ts).
Inputs: docs/progress/specs/core-snapgene.md, docs/progress/findings/snapgene.implementer-report.md,
docs/progress/findings/snapgene.review-findings.json (11 findings). No earlier fix report or log existed
when this session started (2026-10-08).
For every finding: permanent regression test + root-cause fix, or a precise rejection.
End state: whole snapgene suite green, clean typecheck for snapgene files.

## Done so far
- Read common spec, module spec, implementer report, review findings.

## Current state
- (establishing baseline)

## Open problems / decisions
- (none yet)

## Next steps
1. Run snapgene tests + tsc, record baseline.
2. Work through findings 1..11.
