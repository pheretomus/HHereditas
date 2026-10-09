# UI fix: sequence (SequenceView) — fixing review findings

STATUS: IN PROGRESS (started 2026-10-08)

## Goal
Fix the 13 review findings (design review: 9, interaction review: 4) for `packages/viewer/src/sequence/**`
(spec docs/progress/specs/ui-sequence.md). For each: reproduce, then reject with a reason or fix the root cause,
add a regression test where testable, and re-screenshot. End with green tests, a clean typecheck and fresh
light/dark screenshots in /tmp/hh-shots/sequence/. Port 5234 (vite started: /tmp/vite-5234.log).

Findings (numbering used below):
- D1 MAJOR stop codon '*' contrast
- D2 MAJOR light complement / numbers / multi-cutter labels contrast
- D3 minor enzyme hover does not highlight its own cut path
- D4 minor primer 5' tail only a 4-px tick
- D5 minor selected codon's aa cell not highlighted
- D6 minor no residue tooltip/number on translation strip
- D7 minor unfocused selection ~ focused (no gray unemphasized state)
- D8 minor feature pieces other than widest get no outside label
- D9 minor empty-state hint low contrast
- I1 MAJOR reading position drifts on bases-per-row change
- I2 minor shift+click after origin-wrapping selection selects complementary arc
- I3 minor no horizontal caret reveal / drag auto-scroll
- I4 minor genome keystroke / re-layout 34-83 ms

## Done so far
- Read _common-ui.md, ui-sequence.md, both review reports, all source files.
- Baseline: 95/95 tests pass (`npx vitest run src/sequence` in packages/viewer); tsc viewer + desktop clean.
- Baseline screenshots /tmp/hh-shots/sequence/baseline/ — all 9 design findings reproduce visually.
- Contrast math (scratchpad/seq/contrast.mjs): light black .55 = 4.74:1 on white but 4.42:1 on the focused
  selection; .57 alpha passes both (~5.1 / ~4.7). White on --hh-red = 3.55 (light) / 3.41 (dark): FAILS, so the
  reviewer's "white * on red" idea is rejected; dark glyph (FEATURE_LABEL_ON_FILL) on red = ~5:1 both themes.

## Fixed so far (tests green: 99 in src/sequence, viewer tsc clean)
- D1 stop codon: solid --hh-red cell + centred SVG asterisk (FEATURE_LABEL_ON_FILL), SequenceRow translation block.
  Shots: /tmp/hh-shots/sequence/verify/d1-stop-{light,dark}.png
- D2 contrast: .complement = --hh-seq-text @ fill-opacity .66 (5.10:1 light, 6.45:1 dark, measured);
  .number / .enzymeLabel = --hh-text-secondary (4.74 / 6.37). Token request still to write in report.
- D9 empty hint -> --hh-text-secondary (4.74 / 6.37 measured).
- D7 inactive selection fill -> --hh-bg-selected (grey). D5 selected codon cells: blue fill + edge (focused),
  grey (unfocused); RowContent got a custom memo comparator (activeSites / translationSelection / selectionFocused).
  Shots: verify/d5-codon-{focused,unfocused}-*.png
- D3 active enzyme sites (hovered + sites whose range == selection) -> .cutActive 2px accent path on top;
  root[data-enzyme-hover] dims the other cuts. Shots: verify/d3-hover-{KpnI,XmaI}-*.png, d3-selected-KpnI-*.png
- D6 per-codon <title> "Asp 2 (GAC) · DsRed-Express" (translation.ts residueTitle/codonBases/aminoAcidName).
- I1 anchor: updateAnchor keeps anchor.base while the top row contains it; restore clamps offset to height-1.
  (regression test still TODO)
- I2 extendSelectionTo: wrapping selection -> extendBy(short signed head move). Test added in editing.test.ts.
- D8 layout.ts placeOutsideLabels (2nd pass, never adds a lane). 2 tests in layout.test.ts.
  Shots: verify/d8-row1-*.png, d8-420-*.png

## Plan / decisions
- D2: tokens.css is not mine. Complement = var(--hh-seq-text) with fill-opacity .66 (alpha ~.57 light/.58 dark;
  >= 4.5:1 also on the selection). Numbers + multi-cutter labels = var(--hh-text-secondary). Request token
  changes in the report (--hh-seq-text-complement .57 light/.5 dark, --hh-seq-ruler, --hh-enzyme-multi .56).
- D1: stop codon = solid var(--hh-red) cell + '*' drawn as a centred SVG path in FEATURE_LABEL_ON_FILL.
- D9: emptyHint -> --hh-text-secondary. D7: inactive selection fill -> var(--hh-bg-selected).
- I1: updateAnchor keeps anchor.base while the top row still contains it (only offset updates); clamp offset.
- I2: wrapping selections: extendSelectionTo = extendBy(shortest signed move of the head) (continuity model).
- D3: emphasise hovered / selected (selection == site range) enzyme's cut path in accent, 1.75px, on top;
  dim other cut marks while hovering via a root data attribute.
- D5: translation cells under the selection get the selection tint + edge outline (inside RowContent, custom memo).
- D6: per-codon <title> "Lys 123 (AAG) · KanR" on codon cells.
- D8: second pass in layout: pieces without an inside label get an outside label when their lane has room.
- D4: draw the 5' tail bases (lowercase, raised flap, reduced opacity) beside the 5' end; compact "+N nt" when no room.
- I3: horizontal caret reveal in the pendingReveal effect; horizontal auto-scroll in dragApi.tick.
- I4: last; profile prod build; lazy/chunked or cheaper model.

## Next steps
- I1 regression test (component: repeated basesPerRow changes with scroll events -> no drift).
- Component tests for D3/D5/D6 (cutActive path, translation selection rect, codon <title>).
- D4 primer tails, then I3 horizontal reveal, then I4 perf (prod build profiling).
