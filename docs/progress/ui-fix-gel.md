# ui-fix-gel: progress log

## Goal
Fix the 22 review findings for the `gel` UI component (packages/viewer/src/gel/**, spec
docs/progress/specs/ui-gel.md; reviews docs/progress/ui-review-gel-design.md and ui-review-gel-interaction.md).
For each finding: reproduce, then fix root cause + regression test (where testable) + re-screenshot, or reject with
a precise reason. End: green tests, clean typecheck, fresh light/dark screenshots in /tmp/hh-shots/gel/.
Port 5235. Only files under packages/viewer/src/gel/** may be touched.

Finding ids used below: D1..D17 = design critic (in task order: D1 gutter label, D2 tooltip row, D3 lane labels,
D4 showSizes all, D5 band fusion, D6 brightness, D7 leader contrast, D8 344 bp label, D9 doublets, D10 SC/OC,
D11 off-centre column, D12 smear, D13 AA contrast, D14 ring vs label, D15 ladder rounding, D16 no ladder,
D17 thumbnail caption); IA tooltip clipped when scrolled, IB 1 px taller layout, IC stale hover on lanes change,
ID keyboard in smear lanes, IE stale zzReview5125.gallery.tsx.

## Done so far
- (22:20) Started. No predecessor log existed. Read _common-ui.md, ui-gel.md, implementer report, both reviews,
  all gel sources/tests. Baseline: vitest src/gel 56/56 green; tsc -p packages/viewer clean.
- (22:35) Vite on 5235. Reproduction script (scratchpad gelfix/repro.mjs, outputs /tmp/hh-shots/gel/fix/before/):
  ALL browser findings reproduce (D1 '800 bp'@416.5 + tick 417.5; D2 tooltips over the band row; D3 labels cut
  'clone 1…'; D4 0 labels at 900 vs 32 at 1100; D5 '7,242 bp' over the BstEII block, NotI 'Fragment 28';
  D6 PCR#2 dimer alpha 1.0 vs PCR#1 0.51; D7 tertiary 0.32 / 0.24; D8 344 bp missing; D10 '2.69 kb' x2;
  D11 focus 236-343 vs bands 244-292; D12 154 rects; D13 op 0.5/0.6, #007aff w600; D15 '1.5 kb';
  D16 no sizes; D17 gap 48 px; IA 45 px hidden; IB scroll 770 vs 768; ID 'Fragment 1224' after 101 keys).

## Current state
- Gel sources untouched so far (last modified 14:06 by the implementer).

## Plan / decisions
- placeGelLabels: exact least-squares solver with per-label bounds (DP over convex piecewise quadratics) +
  conflict-set dropping (greedy earliest placement) -> fixes D8; gutter labels get midpoint bounds (D1);
  unlabelled ticks skipped when level with another label; leaders/ticks --hh-text-secondary (D7).
- Band thickness/glow capped by the gap to the nearest neighbour; bands closer than ~3.5 px form an
  unresolved group: hover/keyboard summarise the group (D5). Smear lanes: fixed screen rows as units for
  pointer AND keyboard (ID); smoothed profile drawn as a gradient (D12).
- Brightness (D6): GelLane.loadNg (new, optional) and GelLaneBand.massNg give absolute masses -> lanes with
  masses share one scale (heaviest band of the gel = 1). Gallery uses realistic loads.
- Size labels (D4/D16/D9/D10): full -> compact text ('4.36k', '512') -> overlay for the selected lane only;
  no ladder => sample sizes; doublets '517/506 bp'; GelLaneBand.form (new, optional) -> 'SC'/'OC'.
- Tooltip (D2/IA): below/above the band row (>= 10 px from the guide), clamped to the visible scroll viewport.
- IB: integer pad + floor slab height + 1 px tolerance; srOnly at top/left 0.
- IC: re-run hit test at last pointer position on layout change; keyboard inspection follows the band object.
- D3: word-boundary truncation computed in layout, shared-prefix elision, selection = colour only.
- D11: GelLaneGeometry.column (visual column centred on bands / band+own labels); clicks handled on the surface.
- D13: caption/empty full --hh-gel-text; selected label/active ladder label var(--hh-accent-text, --hh-accent-hover).
- D15: ladder labels exact unless lossless ('1,517 bp', '1.2 kb'). D14: SIDE_LABEL_GAP 7, ring +-2.
- D17: figure alignSelf start. IE: delete zzReview5125.gallery.tsx (backup in scratchpad).

## Next steps
1. Implement layout.ts changes + tests; then format.ts; GelView.tsx; CSS; GelBands; gallery.
