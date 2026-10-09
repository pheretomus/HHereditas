# ui-review-circular-design — progress log (adversarial visual/UX review of `<CircularMap />`)

## Goal
Adversarial VISUAL DESIGN & UX review (Apple HIG + SnapGene conventions) of `<CircularMap />`
(packages/viewer/src/circular/**, spec docs/progress/specs/ui-circular.md, implementer report
docs/progress/findings/ui-circular.implementer-report.md). Screenshot every story, light + dark, 900x600 + 1600x1000,
zoom into details at --scale 3, and report concrete, fixable problems with evidence (screenshot path + location +
expected look). Do NOT modify non-temporary files. Dev server port: 5212. Screenshots: /tmp/hh-shots/circular-review-design/.

## Done so far
- Read _common-ui.md, ui-circular.md spec, implementer report and implementer progress log.

## Current state
- Starting. No dev server yet.

## Open problems / decisions
- (none yet)

## Next steps
1. Read component source (CircularMap.tsx, layout.ts, geometry.ts, CSS, gallery) to know the stories.
2. Start vite on 5212, screenshot all stories x {light,dark} x {900x600,1600x1000} into /tmp/hh-shots/circular-review-design/.
3. Inspect each image; zoom crops at --scale 3; interaction scripts (hover/drag/tooltip).
4. Record findings here as they are confirmed; stop server (pkill -f "[v]ite --port 5212"); delete temp scripts.
