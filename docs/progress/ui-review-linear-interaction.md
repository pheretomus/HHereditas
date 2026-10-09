# ui-review-linear-interaction — progress log

## Goal
Adversarial review of `<LinearMap />` (packages/viewer/src/linear/**) with the INTERACTION,
CORRECTNESS & PERFORMANCE lens. Port 5223. Playwright scripts that click/drag/type/scroll/resize on
the gallery stories; verify coordinates (1-based, caret placement, wrap selection), keyboard, focus,
callback arguments, console warnings, empty record, 4.6 Mb record perf; run the layout Vitest tests.
Report only reproduced problems. Do not modify non-temporary files. Shots -> /tmp/hh-shots/linear-review-interaction/.

## Done so far
- Read _common-ui.md, ui-linear.md spec, implementer report + log.
- Vitest src/linear: 126/126 pass.
- Dev server on 5223 running (log /tmp/vite-5223.log).
- TEMP story file (DELETE at end): apps/desktop/src/dev/zzLinearInteract5223.gallery.tsx
  (Host with logging of every callback into window.__lm.log; setters __lm.setSel/setVp/setHl/
  setShow/setWidth/setWhich; stories linear-ctl, linear-unctl, circ-ctl, circ-unctl, pbr-ctl,
  genome-ctl, genome-unctl, tiny-ctl, tinyc-ctl, one-ctl, empty-ctl, empty-unctl, frozen-vp, frozen-sel).
- Scripts in scratchpad lrev/ (lib.mjs helpers; probe, coords, dupes, clicks, circular, circ2, keys).
- Verified OK: ruler ticks at base centres (1-based), letters match seq, click backbone -> caret at
  nearest gap, context menu on backbone -> 0-based base, drag -> gap-snapped range, feature click/
  shift/ctrl/dblclick args + zoom-to-feature (±8 %), hover card text 1-based, enzyme/primer/ORF
  clicks, context targets, Esc, keyboard + = - _ 0 arrows Home End (rapid presses accumulate),
  focus ring on Tab, wrap feature -> two pieces, shift-click keeps wrap.

## Findings so far (reproduced)
1. MAJOR: circular record, drag from left end to past right end (or reverse) -> selection collapses
   to caret 0 (selectBetween mod L). Also caret 0 + shift-click at far right end -> empty. (circular.mjs, circ2.mjs)
2. MINOR: onSelectionChange emitted on every pointermove even when unchanged (55/58 duplicates at
   24 px/bp); onViewportChange emitted for no-op keys (ArrowRight at full view etc.). (dupes.mjs, keys.mjs)
3. MINOR: pressing on a feature emits featureHover(id) then featureHover(null) though the pointer
   stays over it; hover ring + app hover state lost until the pointer moves. (clicks.mjs)
4. MINOR: hover card + app hover state go stale after keyboard zoom/pan (card "CmR 1,826..2,485"
   stays while view shows 4,050-6,250; no featureHover(null)). (misc2.mjs, misc2-stale-tooltip.png)
5. MINOR: protein records: hover card + aria-label use "bp" ("11..230 · 220 bp", "240 bp");
   SequenceView uses "aa". aria-label "1 features". (misc3.mjs, misc3-protein-card.png)
6. MINOR: Escape during a drag clears the selection but the drag continues and the selection
   reappears on the next move (Esc does not cancel the gesture). (misc2.mjs)

## Also verified OK (no finding)
- Wheel: ctrl+wheel notch = 1.25x exactly, pinch-like deltas exp(-0.01*dy), bp under pointer fixed;
  shift+wheel / horizontal wheel pan pixel-exact; plain vertical wheel native. Scrollbar thumb drag
  and track click exact; autoscroll at the right edge works (wheel.mjs).
- frozen-vp parent: map snaps back, no loop. Resize: no spurious events. Record switch resets.
  Tiny 10 bp / 1 bp records: clicks + drags clamp correctly. Empty record: "No sequence", no events,
  no errors (edges.mjs).
- PERF (perf.mjs dev, perf-prod.mjs production harness in scratchpad lrev/prod): production build:
  mount->paint 27 ms (x1), 106 ms (x4 CPU); 60 fps p99 16.8 ms for zoom/pan/hover/drag/key glides at
  x4; at x6 only 1-3 frames of 33 ms. Dev build at x4 drops to ~30 fps but profile shows React DEV
  overhead (jsxDEV, StrictMode double render) dominates -> NOT a finding.

- Also OK: short pane vertical scroll + clicks; narrow->deep zoom->widen re-clamps and reports;
  highlight ring; dblclick background zooms 2x at pointer; drags ending outside map/window then
  click OK; native context menu kept when no handler; tooltip flips at right edge; WebKit gesture
  events zoom exactly, ctrl+wheel ignored during gesture; Home/End at zoom; shift+drag; origin card
  "3,922..2 · 19 bp"; 21 official stories x 2 themes with interaction: 0 console problems;
  tsc viewer clean, desktop no linear errors.

## Next steps
- Last checks: zoom-to-selection on wrap selection (interactive-circular), card after native
  vertical scroll, genome selection precision when zooming in.
- Final: delete temp story (apps/desktop/src/dev/zzLinearInteract5223.gallery.tsx), stop vite, report.
