# UI review: gel (interaction, correctness & performance) — FINAL

## Goal
I tested `packages/viewer/src/gel/**` (GelView, GelThumbnail) against `docs/progress/specs/ui-gel.md` and `docs/progress/findings/ui-gel.implementer-report.md`. The checks covered clicks, hover hit-testing, keyboard, focus, callback arguments, console warnings, empty data and performance on the 4.6 Mb genome. Only problems I reproduced are reported. I worked on port 5225 and saved screenshots under `/tmp/hh-shots/gel-review-interaction/`.

## Status: DONE
- **Vitest `src/gel`:** 3 files, 56 tests, all pass.
- **Typecheck:** `tsc -p packages/viewer` shows no errors in the gel files. One unrelated error is in core: `translate.ts` CHAR_M.
- **Cleanup:**
  - My temporary files are deleted: the `zzGelInteract5225.gallery.tsx` story, the `zzReviewStaleHover5225.test.tsx` test, and the scratchpad scripts (`gelint/`, `prodperf/`).
  - The Vite server on 5225 is stopped.

## Verified OK (no finding)
- **Hover:** every band centre and size label hits the right lane and the caller's own band object. Leaving a band or the gel reports `(laneId, null)` exactly once.
- **Clicks:** clicks on lane centres, column edges and lane labels (including 45° labels in the 48-lane gel) report the right lane id. Clicks on slab margins report nothing. Press–drag–release across lanes causes no accidental selection.
- **Keyboard:** Tab, Arrow keys, Home/End, Up/Down, PageUp/PageDown, Enter/Space and Escape all behave as documented. There is a single roving tab stop, a visible focus ring, live-region announcements, and `aria-describedby` points to the tooltip.
- **Smear hover:** the aggregate (mean size, count, size range) matches the layout exactly.
- **Empty cases:** a lane with no bands announces "no bands"; the no-lanes gel shows "No lanes".
- **Thumbnails:** 0 lanes and 40×40 both render.
- **Long labels:** every ellipsized lane label has a full-text tooltip (9 stories × 7 sizes).
- **Randomized property test:** 400 random gels using the real text measurer: hit-testing is exact, labels never overlap, and every size label is closest to its own band.
- **Console:** no warnings or errors across 14 stories × 2 themes × 2 sizes with sweeps, clicks, keys and resizes.
- **Performance (production React build):**
  - The genome gel (18,812 fragments) renders in about 14 ms, with 362 DOM nodes.
  - Live width and height resizing and hover sweeps hold 60 fps: no frames over 20 ms.
  - The development build with StrictMode drops frames while resizing (p95 33 ms). This comes from dev-mode overhead only.

## Findings
**A (major): tooltips are clipped or invisible when the gel scrolls sideways.**
- The tooltip is placed within the full scrollable canvas (`layout.width`), not the visible part of the scroll container.
- In the `GelView/many-lanes` story at 600×560, the Colony 44 tooltip is 47% hidden.
- With 96 lanes at 900×600, the tooltip is 100% hidden. Lane labels are hidden in that mode, so the tooltip is the only way to identify a lane.
- Screenshots: `A-*.png`.

**B (major): the layout is often 1 px taller than its box, which adds a scrollbar.**
- In about 31% of sizes the layout comes out 1 px taller than its container. The cause is that `pad` is fractional while `slab.y` and `slab.height` are rounded separately, then the total is rounded up with `ceil`.
- The root then switches to `overflowY: auto`. At 1366×768, 1024×768 and 1000×650 this shows a real scrollbar where scrollbars are not overlays, and the wheel scrolls the gel by 2 px.
- The no-lanes gel also gets an extra Tab stop with no visible focus ring.
- `GelView/digest` at 1366×768: root 768 px, canvas 769 px, scrollHeight 770 px.
- Screenshots: `B-*.png`.

**C (minor): hover state is not re-checked when `lanes` changes.**
- The hover is tracked by band index. If the hovered lane is removed, `onBandHover(…, null)` is never called.
- If new lanes arrive with shifted positions, the tooltip and ring stay on the old band index, 65–87 px away from the pointer, and no callback fires.
- Screenshot: `C-*.png`.

**D (minor): keyboard stepping through a smear lane goes one fragment at a time.**
- The Sau3AI lane has 18,059 fragments. After 1,001 steps the cursor has only reached 733 bp.
- The keyboard announces "Fragment 1224", while the pointer at the same spot shows "270 fragments, 702–765 bp".
- Screenshot: `D-*.png`.

**E (minor): a temporary file from an earlier reviewer was left in the component folder.**
- `packages/viewer/src/gel/zzReview5125.gallery.tsx` is labelled "Delete before finishing" but is still there. I did not touch it because it is not mine.

## Next steps (for a fixer)
- **A:** clamp the tooltip to the visible part of the scroll container (`root.scrollLeft` … `scrollLeft + clientWidth`, and the same vertically), or render it in a portal or fixed layer.
- **B:**
  - Make `slab.y + slab.height + pad` never exceed H: round `pad` first, or compute the height as `H - slab.y - round(pad)`.
  - Position the `srOnly` live region with `top: 0` so it adds no scrollable overflow.
- **C:** in an effect on `[layout]`, re-run the hit test at the last pointer position (or clear a pointer inspection), and report `(prevLaneId, null)` when the inspected lane disappears.
- **D:** in smear lanes, step in screen rows: the same `[start, end)` ranges the pointer uses, with the smear summary as the announcement.
- **E:** delete `zzReview5125.gallery.tsx`.
