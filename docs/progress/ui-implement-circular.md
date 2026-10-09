# ui-implement-circular — progress log (FINAL)

## Goal
Build `<CircularMap />` (packages/viewer/src/circular/**) to production standard per
docs/progress/specs/ui-circular.md + docs/progress/specs/_common-ui.md. Dev server port 5202.
Final screenshots: /tmp/hh-shots/circular/final/. Report: docs/progress/findings/ui-circular.implementer-report.md.

## Done
- (3rd attempt) Read the specs and all predecessor code; it was sound (SnapGene-style label columns, curved inside
  labels, lane packing, wedge selection, cumulative-angle drag, tooltips, tests), so I kept it and polished it.
- Audit: the original 84 tests passed and tsc was clean. Screenshotted all stories × light/dark ×
  900x600/1600x1000 with no console errors. Real-browser interaction checks (hover, enzyme hover, drag across the
  origin cw/ccw, shift+click extend, Escape, click feature, focus ring) all OK.
- Polish pass 1:
  - Primer arrows: at least 14 px long, tip on the 3' end, 6 px off the backbone; the model reserves lane room
    (`PrimerItem.extent`) so arrows never touch.
  - `MapLayers` renamed `MapShowOptions` (the LinearMap name).
  - Barrel trimmed: component API plus circular-prefixed helpers.
  - Heavy maps (> 800 items) re-lay out lazily during live resize (`useLayoutSize`, viewBox scaling, pointer
    mapping): genome 197 -> 16 ms/step.
  - Drag emits only on change; tooltip uses the tooltip tokens.
- Polish pass 2:
  - `featurePieces()` merges an origin-split join into one continuous piece (no seam).
  - New `edge-cases` story.
  - Hovering an enzyme emphasizes all of its sites.
  - Caret live-region wording.
- Final: 91/91 tests (geometry 16, layout 49, component 26); tsc clean (viewer + desktop; the only error is in
  core's translate.ts, not mine).
  - 84 story screenshots plus interaction shots in /tmp/hh-shots/circular/final/ (and interaction/); predecessor
    shots moved to /tmp/hh-shots/circular/_previous/.
  - Report written. Dev server on 5202 stopped.

## Current state
- COMPLETE. Nothing pending.

## Open problems / decisions (documented in report)
- Unnamed features (name == type) rank below enzymes on large maps and below primers on small maps (a deliberate
  refinement of the spec's priority order).
- pBAD30 fixture labels contain backslashes ("operator\O2"): this is data from the parser/fixture, not a render bug.
- Optional token request: `--hh-feature-label-on-fill` for the shared FEATURE_LABEL_ON_FILL constant (common/colors.ts).

## Next steps (for whoever continues)
- Integrator: export one copy of MapTarget / FeatureClickInfo / MapShowOptions in the package barrel
  (`circular/index.ts` and `linear/index.ts` both export them).
