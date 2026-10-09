# ui-implement-linear — progress log

## Goal
Build `<LinearMap />` (packages/viewer/src/linear/**) to production standard per
docs/progress/specs/ui-linear.md + _common-ui.md. Port 5203. Shots -> /tmp/hh-shots/linear/.
Final report -> docs/progress/findings/ui-linear.implementer-report.md.

## Done so far (attempt 3)
- Audited predecessor work (~6,300 lines): feature-complete vs spec (lanes fwd above / rev below,
  label placement inside/beside/outside, staggered enzyme rows, primers, ORFs, density for
  sub-pixel features, letters >= 8 px/bp, wheel/pinch zoom, pan, drag-select, keyboard,
  overview scrollbar, hover card, controlled/uncontrolled selection + viewport).
- Baseline: 116 tests pass; tsc clean for linear (only core error: translate.ts CHAR_M, not ours).
- Screenshots of all stories, both themes, 900x600 + 1600x1000: /tmp/hh-shots/linear/v5/.
- Playwright interaction script (scratchpad interact.mjs) verified: hover card, click select,
  shift-click extend, dbl-click zoom-to-feature, ctrl+wheel zoom keeps bp under pointer,
  shift/horizontal wheel pan, drag select, context target, keys + - 0 arrows End Esc.
- FIXED: labels of features lying in the off-screen drawing margin were clamped to the map edge
  (detached "KS primer" / "pBR322ori-F" labels). layout.ts: MIN_VISIBLE_PX + 'outside' label
  must overlap its bar's visible part. LinearMap.tsx pinned-label 2nd pass now uses
  featureOnScreen (hitTest.ts). Pinned features inside density bands now get a label candidate.
  +2 tests (118 total), verified the detached-label test fails without the fix.

- FIXED: RNA/protein (single-stranded) letters were drawn over feature lane 0. strandGapFor(k,
  singleStranded) opens an 18 px band; the single line runs under the letters (BackboneModel
  topY/bottomY). +1 test. New gallery story 'protein' (protein overview + RNA at letter zoom).
- ADDED: labelColor.ts: inside-label text picks near-black or light (var(--hh-accent-contrast))
  by WCAG contrast for custom '#rrggbb' fills (dark custom colours were illegible). +3 tests.
- ADDED: gallery story 'exons-introns' (demoGeneLocus in galleryData.ts: spliced genes on both
  strands, dark custom colours). Verified connectors + 3' arrow heads visually.
- Perf (browser, genome-interactive): 60 fps p99 for wheel zoom/pan/hover/drag, no long tasks;
  with 4x CPU throttle + 2x DPR still p99 16.8 ms except keyboard glides (p90 33 ms).
- Circular map now also exports `MapShowOptions` (same name as linear): no change needed.

- CHANGED (consistency with circular map + cleaner dark theme): selection fill is now an
  underlay (SelectionUnderlay, behind features) + SelectionOverlay (edges/caret on top);
  label halos removed, instead enzyme leaders are interrupted around outside feature labels and
  primer labels (layout.ts leaderPath). +3 tests (leaderPath unit + no-crossing invariant).
- Scratchpad is shared with other agents: my helpers live in scratchpad/linear-ui/
  (shots.mjs, interact.mjs, perf.mjs, perf-throttled.mjs).

- FIXED: a controlled viewport that the map had to clamp (too deep, outside the record, tiny
  record centred) was shown clamped but never reported, so app zoom buttons drifted. New effect
  in LinearMap.tsx reports the clamped window once via onViewportChange (loop-safe). +1 test.
  Verified in browser: Zoom to selection on a 20 bp primer -> app state 2,084-2,137 (53 bp).
- Final screenshot set: /tmp/hh-shots/linear/final/ (18 stories x 2 themes x 900x600/1600x1000).

## Current state (FINAL)
- DONE. Tests 126/126 (src/linear, 9 files; viewer package 368/368). tsc: viewer clean, desktop has
  no linear errors. Dev server on 5203 stopped.
- Final screenshots: /tmp/hh-shots/linear/final/ (18 stories x light/dark x 900x600 + 1600x1000,
  plus 6 interaction frames). Report: docs/progress/findings/ui-linear.implementer-report.md.

## Open problems / decisions
- pBAD30 fixture labels contain backslashes ("operator\O2"): data/parser issue, not viewer.
- Requested tokens: --hh-feature-label-on-dark (fallback var(--hh-accent-contrast)); optional
  --hh-map-leader.
- Shared types (MapTarget, FeatureClickInfo, MapShowOptions) duplicated per folder by design;
  integrator must export one copy in packages/viewer/src/index.ts.

## Next steps
- None required. Possible follow-ups: jagged ends for partial features; share labelColorOnFill
  via common/colors.ts with circular/sequence views; SVG export helper for the app.
