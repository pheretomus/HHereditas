# core-fix-genbank: progress log

## Goal
Finish the review fixes for module "genbank" (packages/core/src/io/genbank*.ts, fasta.ts, location.ts).
For each of the 16 findings in docs/progress/findings/genbank.review-findings.json: permanent regression
test + root-cause fix, or a precise rejection. End with the module's whole test suite green and a clean
typecheck for the owned files.

## Done so far
- Read _common-core.md, core-genbank.md spec, implementer report, review findings (16 entries; duplicates:
  #0 = #6 spread RangeError, #1 = #7 quadratic location, #5 = #8 inner fuzzy at origin).
- No predecessor log and no genbank.fix-report.json existed when this session started.

## Current state
- (establishing baseline: tests + typecheck)

## Open problems / decisions
- (none yet)

## Next steps
1. Run module tests + tsc, record baseline.
2. Check which findings already have regression tests / fixes.
