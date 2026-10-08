# core-fix-primers — progress log

## Goal
Finish the review fixes for module `primers` (packages/core/src/primers): for each of the 16 findings in
docs/progress/findings/primers.review-findings.json ensure a permanent regression test exists, then fix the root
cause or reject with a precise reason. End with the whole primers suite green and a clean typecheck for primers files.

## Done so far
- (start, 2026-10-08 21:44 KST) Read _common-core.md, spec core-primers.md, implementer report, 16 findings.
  No earlier fix report and no earlier progress log existed. Predecessor edits are committed in HEAD (b18e327):
  new files normalize.ts and tm-extremes.ts are not in the implementer report, so a fix run had started.

## Current state
- Establishing baseline (tests + typecheck) next.

## Open problems / decisions
- (none yet)

## Next steps
1. Run `npx vitest run src/primers` and `npx tsc --noEmit -p packages/core`, record failures.
2. Map each finding to existing tests / code state.
