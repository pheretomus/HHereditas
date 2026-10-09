# UI review: gel (visual design & UX critic) — FINAL

## Goal
Adversarial review of the `gel` component (packages/viewer/src/gel/**, spec docs/progress/specs/ui-gel.md,
implementer report docs/progress/findings/ui-gel.implementer-report.md) through a visual design & UX lens
(Apple HIG + SnapGene/biology conventions). Read-only review: no repository source files were modified.

## Done
- Read _common-ui.md, ui-gel.md, implementer report and all gel sources.
- Own Vite server on port 5215 (now stopped). 56 story screenshots (14 stories x light/dark x 900x600/1600x1000),
  no console errors; contact sheets per story; zoomed clips at scale 3-4; Playwright hover/click/keyboard checks;
  WCAG contrast computed from token values; label-placement claim re-checked by running the shipped
  placeGelLabels on the measured band centres.
- Temporary scripts lived in the session scratchpad and were deleted. No stories were added to the repo.

## Evidence
/tmp/hh-shots/gel/design-critic/
- <story>-{light,dark}-{900,1600}.png for all 14 stories; sheets/<story>.png (2x2 contact sheets)
- zoom/: twelve-lanes-right-gutter-light.png, dense-ladder-bsteii-top-light.png, long-labels-header-light.png,
  long-labels-header-select-c3-light.png, interactive-hinfi-labels-light.png, genome-smear-lanes-dark.png,
  hover-ring-vs-label-light.png, dense-ladder-left-gutter-dark.png, many-lanes-left-gutter-light.png, thumbnails-dark.png
- interact/: hover-ladder-5kb-*.png, hover-2.29kb-*.png, hover-doublet-*.png, hover-bsteii-block-light.png,
  many-lanes-hover-colony20-dimer-light.png, focus-tab-*.png, focus-keyboard-band-*.png, label-tooltip-*.png,
  smear-hover-*.png, twelve-hover-100bp-517-light.png

## Findings (17; reported via StructuredOutput)
critical
1. twelve-lanes 900x600: right-gutter "800 bp" label level with the 900 bp band next to its unlabelled tick.
major
2. Band tooltip centred on the band row hides neighbouring lanes' same-height bands and the guide line.
3. Lane labels tail-truncated inside numbers ("clone 1…" for clone 12); selection (semibold) removes the number.
4. showSizes='all' renders 0 sample labels for 12 lanes below ~1000 px (32 at 1100 px).
5. Bright neighbouring bands fuse (λ/BstEII 8.45/7.24/6.37/5.69 kb at 900x600); tooltip reports one fragment.
6. Per-lane intensity normalisation: primer-dimer-only lanes glow like strong products.
7. Leaders/unlabelled ticks below 3:1 (2.24/2.90 and 1.78/2.20).
minor
8. 344 bp size label dropped though a valid placement exists (verified with shipped placeGelLabels).
9. Doublets labelled with synthetic mean size ("512 bp", "5.72 kb") without ≈/count.
10. Uncut plasmid SC/OC bands both labelled with the molecule size.
11. Focus ring / hover / selection column off-centre on ladder lanes when showSizes='all'.
12. Smear lanes: hard edges, stair-steps, random pseudo-band stripes.
13. Caption 3.3:1, "No lanes" 4.1-4.2:1, selected label 4.0:1 (below AA).
14. Hover ring 1.5 px from the size label.
15. Ladder labels round vendor sizes (1,517 -> "1.5 kb"; λ/HindIII 2,027 -> "2 kb").
16. No ladder lane -> no size information at all (single-lane).
17. Gallery: "96 × 120" caption detached from its thumbnail.

## Open problems / decisions
- packages/viewer/src/gel/zzReview5125.gallery.tsx and zzGelInteract5225.gallery.tsx belong to other concurrent
  reviewers (ports 5125 / 5225); not touched.
- Finding 6 is partly a data-contract issue shared with core (core-gel spec also normalises per lane).

## Next steps (for the fixer)
- Fix 1 + 7 together (midpoint bounds for gutter labels, no tick at a moved label's row, ≥3:1 leaders).
- Fix 2 (tooltip off the band row), 3 (token-boundary truncation, same-width selection), 4 (progressive degradation),
  5 (thickness/glow capped by neighbour gap + aggregated tooltip), then the minors.
