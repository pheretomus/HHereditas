# ui-review-circular-interaction — progress log

## Goal
Adversarial INTERACTION / CORRECTNESS / PERFORMANCE review of `<CircularMap />`
(packages/viewer/src/circular/**, spec docs/progress/specs/ui-circular.md, implementer report
docs/progress/findings/ui-circular.implementer-report.md). Write Playwright scripts against the gallery stories
(own Vite dev server on port 5222) that click, drag, type, scroll and resize; verify coordinates (1-based visible
positions, caret/selection exactly where clicked, drag across the origin selects the wrapping arc), keyboard, focus,
callback arguments, console warnings/errors, empty record, the 4.6 Mb genome (first render, frame times). Run the
Vitest suite. Report only reproduced problems with exact steps/scripts. Do NOT modify non-temporary files.
Screenshots: /tmp/hh-shots/circular/review-interaction/ (review evidence).

## Done so far
- Read _common-ui.md, ui-circular.md spec, implementer report + log, all circular source.
- vitest src/circular: 91/91 pass; tsc viewer + desktop: clean (22:15).
- Vite dev server on 5222 (log /tmp/vite-5222.log).
- TEMP files (delete at end): apps/desktop/src/dev/CircularReviewTmp.gallery.tsx (logging story: window.__cm.log,
  URL params rec=pFA6a|pBR322|pBAD30|linear|genome|empty|empty-linear|tiny|one|primers, ctl=0 uncontrolled, rot, hl, fw/fh);
  Playwright scripts in the session scratchpad (lib.mjs, probe*.mjs).
- probe1 (pFA6a 1000x800): caret clicks, drag cw/ccw across origin, >1 turn, feature click (extent + onFeatureClick
  info), wrapping SP6 promoter (tooltip 3,922..2), dblclick clickCount 1,2, enzyme label/tick click, shift+click
  extend keeps direction, Escape, context-menu targets: ALL behave correctly. Off-by-1..3-base results were test
  artifacts (Chromium floors fractional mouse coords; 1 bp < 0.3 px) -> redo with integer coords.

- probe2: integer-coordinate precision 72/72 exact (caret + context-menu base); caret drawn at click angle; Tab focus
  ring visible; keys other than Escape do nothing (documented limitation).
- probe3 (linear record): precision 36/36 exact; gap clicks snap to 0 / L; drag through the gap clamps (by design).
- probe4: empty / empty-linear / 1 bp / 10 bp records: no crashes, no console errors.
- perf1/perf3: genome story = 3,042 features only (not ~4,500); own 4,500 / 9,000-feature genomes (temp story
  rec=genome4500|genome9000): hover/drag 60 fps, first-load long frame 389 / 531 ms, resize-settle frame 183-324 ms.

- probe5-8: uncontrolled mode OK; rotation 90/37/-45 precision 0 mismatches + drag across rotated origin OK; primers
  (incl. origin-wrapping, tooltip 3,929..10) + ORFs (wrapping 3,703..124) click/tooltip OK; outside-label click and
  shift+click cover OK; shift+drag OK; drag starting on a feature fires no featureClick OK; hover-leave emits null OK;
  genome click while scaled mid-resize maps exactly; edge-cases story ranges all correct; release outside window OK.
- perf4: pBR322 hover render p50 0.7 ms / max 1.4 ms; live resize render p50 4.8 / max 12.2 ms; no frame > 20 ms.
- perf5: genome REMOUNT (fonts already loaded) still does an extra ~70 ms full re-render (fonts.ready bump).

## Current state
- Evidence screenshots in /tmp/hh-shots/circular/review-interaction/.

## Findings so far (reproduced)
1. [minor/major?] Linear record: straight drag through/near the centre crossing 12 o'clock leaves the selection stuck
   (2000 -> 6500 gives 0..2000, caret 0; 6500 -> 2000 gives 6500..8596). probe3.mjs, p3-linear-straight-*.png.
2. [minor] Press on an outside label / outside the ring, release elsewhere: click acts on the release target (selects
   AmpR / sets a caret, replacing the selection). probe2.mjs.
3. [minor] Empty record (0 bp): right-click in the ring reports {kind:'sequence', position:0} (no such base). probe4.mjs.
4. [minor] Genome perf story + layout test have ~2,800-3,042 features, not the ~4,500 the spec requires / docs claim.
5. [minor] Escape during a drag clears, but releasing the button re-emits the drag selection (probe7.mjs).
6. (part of 2, strongest form) With a selection, dragging along the ring 16+ px outside the backbone (dragOuter =
   ringOuter+10) selects nothing and on release CLEARS the selection (background click). probe8.mjs,
   p8-before.png / p8-after-drag-outside-ring.png.
7. [minor] Every mount (not once) re-lays out after fonts.ready even when fonts are loaded: genome +~70 ms (perf5.mjs).

## Open problems / decisions
- (none yet)

## Next steps
- Uncontrolled mode, rotation precision, primers/ORF clicks + tooltips, outside feature-label click, tooltip at edges,
  light-map resize (selection kept), release outside window, shift+drag, hover callback order, highlighted feature.
- Then: delete temp story + scripts, stop vite (pkill -f "[v]ite --port 5222"), finalize this log, report.
