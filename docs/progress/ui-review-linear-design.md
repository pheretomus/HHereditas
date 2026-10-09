# ui-review-linear-design — progress log

Role: adversarial VISUAL DESIGN & UX reviewer of `<LinearMap />` (packages/viewer/src/linear/).
Port: 5213. Screenshots: /tmp/hh-shots/linear/review-design/. Read-only review (no project edits).
Temp scripts: session scratchpad `lrd/` (batch.mjs = one-browser version of shot.mjs).

## Goal
Screenshot every LinearMap gallery story (light + dark, 900x600 + 1600x1000), zoom into details at
--scale 3, and report concrete, observed, fixable visual/UX problems (overlap, clipping, alignment,
spacing, hierarchy, token use, contrast, dark-mode glitches, biologically misleading rendering).

## Done so far
- Read _common-ui.md, ui-linear.md spec, implementer report + implementer progress log.
- Vite on 5213; all 21 stories x light/dark x 900x600/1600x1000 captured (84 PNGs, no console errors):
  /tmp/hh-shots/linear/review-design/<story>-<theme>-<W>x<H>.png
- Viewed: pFA6a-kanMX6, pBAD30, pBR322, linear, features-only, exons-introns, primers-orfs,
  zoomed-bases, zoomed-features, selection, selection-wraps-origin, caret.
- Verified zoomed-bases biology against fixture seq: letters, 1-based ticks, top/bottom cut positions
  for PstI/SalI/BamHI/XmaI/SmaI all correct; selection 43..48 = GGATCC correct.

## Candidate findings so far (to confirm with crops / DOM checks)
1. MAJOR: unique cutters dropped while multi-cutters keep labels; label set differs by width.
   pBAD30 @1600: ClaI, MluI, EcoRI, SacI, XbaI, SbfI unlabeled (EcoRI/XbaI/ClaI/MluI ARE labeled @900);
   pBR322: ClaI(24), AatII, SspI(4,170) unlabeled at both sizes, HindIII(29) missing @900;
   pFA6a: BamHI(43), PvuII(15), AscI(63) unlabeled at both sizes; linear @1600: XhoI, HpaI missing.
2. Selection edges / caret drawn over labels: "TEF p|romoter", "pBRfor|Eco", "AmpR promote|r"
   (selection-wraps-origin), "|T7 promoter" + "|500" tick (selection), "ara|C\promoter",
   "|operator\I2\and\I1" (caret). Both themes.
3. Feature labels only one row outside a lane: many features unlabeled though canvas mostly empty
   (features-only @900: 2nd CMV promoter, 5' LTR #2, HIV-1 Psi, gp41, KS primer, miR-30a parts;
   pBR322 @900: ROP protein CDS unlabeled while 'misc_binding'/'tet' 2-bp bits are labeled).

## Update 2 (all 21 stories viewed)
- TEMP story file (DELETE at end): apps/desktop/src/dev/zzLinearDesign5213.gallery.tsx
  (long-protein, sticky5-right, sticky3-left/right, pFA6a-unique-only, pBAD30-unique-only).
- Sticky ends 5'/3' both sides render correctly. tiny: EcoRI cut geometry correct.
- CONFIRMED (DOM, labels.mjs/labels2.mjs): unique-cutter labels dropped while multi-cutters shown, at
  every width; even with ONLY unique cutters passed: pBAD30 @900 misses EcoRI, SacI, XbaI, SalI;
  @1600 misses ClaI, MluI, SacI, XbaI, SbfI; pFA6a misses BamHI/PvuII/AscI at 1320 and 1600, 7/19
  at 900 (AatII lost although right half is empty). 6-row cap; 169-356 px empty above top label.
- CONFIRMED: protein ruler "5 kb..30 kb" (34,350 aa temp story); protein hover "11..230 · 220 bp",
  RNA hover "76 bp" (hover-protein-*.png).
- Noted: dark-mode density band (genome) looks muddy brown; genome-60kb labels on two baselines
  6 px apart; tick labels "1,200 kb"/"1,260 kb" 3 px from window edges.

## Next steps
1. (done) View remaining stories.
2. --scale 3 crops of: label/edge overlaps, reverse primer glyph direction, ORF contrast, truncation
   ellipsis, staggered cut lines vs complement letters, scrollbar.
3. DOM script: list rendered enzyme labels per story/width vs unique-cutter set.
4. Write findings JSON; stop vite (pkill -f "[v]ite --port 5213"); delete scratchpad scripts.
