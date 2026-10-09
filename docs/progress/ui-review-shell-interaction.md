# UI review: shell (interaction, correctness and performance)

## Goal
Adversarial review of the shell components (spec `docs/progress/specs/ui-shell.md`, implementer report
`docs/progress/findings/ui-shell.implementer-report.md`), using an interaction, correctness and performance lens.
Playwright scripts click, drag, type, scroll and resize the gallery stories; check coordinates (1-based user-visible
positions), keyboard behaviour, focus, callback arguments, React console warnings, the empty record and the synthetic
4.6 Mb record (time to first render, frame times). Run the Vitest suites. Report only reproduced problems.
Dev server port: 5221. Screenshots: /tmp/hh-shots/shell-review-interaction/.

## Done so far
- (starting) Read _common-ui.md.

## Current state
- Nothing run yet.

## Open problems / decisions
- none yet

## Next steps
1. Read ui-shell spec + implementer report, galleries, shell sources.
2. Start vite on 5221; run vitest for packages/ui and apps/desktop shell; tsc.
3. Write Playwright scripts under the scratchpad (not in the repo) for each area.
