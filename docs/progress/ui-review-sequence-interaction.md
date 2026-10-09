# UI review: sequence (SequenceView), interaction / correctness / performance lens

STATUS: FINISHED (2026-10-08). Temporary probe story and scratchpad scripts deleted; Vite on 5224 stopped.

## Goal
Adversarial review of `packages/viewer/src/sequence/**` (SequenceView) against
`docs/progress/specs/ui-sequence.md` and `docs/progress/findings/ui-sequence.implementer-report.md`.
Lens: interaction, correctness, performance. Playwright scripts that click, drag, type, scroll and resize the
stories; check coordinates (1-based display, caret placement, origin wrap), keyboard, focus, callback arguments,
console warnings, the empty record, and 4.6 Mb genome performance. Run the Vitest suite. Report only reproduced problems.

## Done
- Vitest `src/sequence`: 4 files, 95/95 pass. tsc (viewer + desktop): the only error is in packages/core/src/seq/translate.ts (not this component).
- A temporary probe story (`SeqViewReviewProbe.gallery.tsx`, now DELETED) logged every callback to `window.__hhlog`.
  Playwright scripts lived in the session scratchpad (now deleted). The key reproduction steps are copied into the findings below.
- Everything below PASSED:
  - Click → caret: left/right half of a glyph → gap before/after, top and complement strand, group gaps, number column → row start,
    right margin → row end (caret drawn at the end of that row), row padding, below the content of a short record → L.
  - Drag: forward and backward across rows, shift+click (anchor kept, direction flips), auto-scroll down/up and with the pointer outside
    the window, stops on mouseup, drag past the end of a circular record → ..L.
  - Keyboard: arrows, Up/Down keep the column, Home/End, Ctrl+Home/End reveal, Ctrl+Arrow by 10, PageDown, shift+arrows over the
    origin (caret 0 + shift+Left → L-1..L; caret 3 + shift+Left ×6 → 3935..3941), collapse with Left/Right, Ctrl+A, Escape,
    shift+Up/Down/Home/End.
  - Editing: typing, IUPAC, invalid → onInvalidInput, Backspace/Delete, replace, paste (FASTA header, digits, whitespace, U→T cleaned),
    invalid paste, cut, copy of a wrapping selection, Ctrl+C/X with no selection leave the clipboard alone, Backspace at the circular
    origin, Delete/typing over a wrapping selection, IME composition via CDP (Korean jamo → onInvalidInput; "acgt" commit → one insert).
  - Annotations: feature click/double-click (clickCount 1 then 2), shift+click cover, origin-spanning SP6 promoter (3921..3940) from
    either piece, codon clicks on forward KanR and reverse AmpR incl. the stop codon (drawn letters checked against the standard code),
    enzyme and primer clicks, context-menu targets for sequence/complement/feature/background/primer/translation/enzyme, selection
    unchanged by right-click, hover enter/leave events.
  - Focus: Tab → inset ring + caret at the first visible row; Tab out → inactive caret; Shift+Tab keeps the selection; pointer focus has
    no ring; live region uses 1-based numbers (including wrap).
  - Empty linear/circular: hint, click, typing ACGT in order, Backspace, select-all + Delete, context menu; read-only empty ignores typing.
  - Uncontrolled selection mode. Scaled scrolling (genome bpr=20, 15M px spacer): clicks, ArrowDown reveal, drag auto-scroll.
  - All 21 official stories × light/dark × 900×600/1600×1000 with wheel/click/keys: 0 console warnings or errors.
- Performance (4.6 Mb genome, 5,033 features):
  - Dev server: wheel (100 and 1000 px/event), PageDown, ArrowDown repeat, drag auto-scroll: every frame 16.7 ms; random scrollTop jumps
    24 ms avg / 31.7 ms max.
  - Dev-only artifact: about 2 s per keystroke and a 2 s first-render long task. A CPU profile attributes about 1.85 s of that to React 19's
    DEV-only `logComponentRender` / `addObjectDiffToProperties`, which deep-diffs the big `record` and per-row `ctx` props.
    This is NOT a product problem.
  - Production build (React prod, served via page.route): the view mounts in about 122 ms after the data is ready. A keystroke takes
    34–78 ms (avg 53), made of about 23 ms row-model rebuild, about 8 ms forced layout reading scrollTop, and about 10 ms GC.
    A bases-per-row change on resize takes 57–83 ms.

## Findings (confirmed, with reproductions)
1. MAJOR: the reading position drifts back on every bases-per-row change (window resize, panel toggles).
   - Cause: the anchor stores the row START (`rows[r].start`). The scroll event caused by the restoring `el.scrollTop = next`
     then runs `onScroll` → `updateAnchor`, which replaces the anchor with the start of the new row. That start is ≤ the old anchor,
     so every change of N loses up to N-1 bases, and the loss accumulates.
   - Repro 1: story SequenceView/pBAD30 at 1600×900, scroller.scrollTop=2600, resize 1600→700→1600 in 10 px steps.
     The first visible row goes from 3,201 to 2,401, and the row that was at the top ends at y≈655 of 900.
   - Repro 2: story linear, 1320↔1100 six times. The first visible row goes 6,111 → 5,721.
2. MINOR: shift+click after an origin-wrapping selection selects the complementary arc.
   - Steps: on pFA6a, click gap 3, press shift+Left ×6 → 3935..3941 (anchor 3). Shift+click gap 10 → 10..3941, which is 3,931 of 3,938 bp.
   - Control: plain click 3 + shift+click 10 → 3..10, and drag 3→10 → 3..10.
   - Code: editing.ts `extendSelectionTo` keeps the old direction even when the head crosses to the other side of the anchor.
3. MINOR: there is no horizontal caret reveal when a fixed basesPerRow is wider than the view.
   - Steps: story bases-per-row-60 at 560×600 (content 638 px, view 550 px).
   - End → caret at x=614 (hidden). With scrollLeft 78, Home → caret at x=-15 (hidden).
   - Drag selection also has no horizontal auto-scroll.
4. MINOR (disclosed by the implementer): each production keystroke on the 4.6 Mb genome takes 34–78 ms, and each re-layout on a
   bases-per-row change takes 57–83 ms. Cause: the whole row model is rebuilt per edit and per change of N.

Screenshots: /tmp/hh-shots/sequence/review-interaction/ (key evidence: t9-drift-before-1600.png, t9-drift-after-restore-1600.png,
t9-drift-after-shrink-700.png, t12-shiftclick-after-wrap.png, t10-bpr60-560px-end-caret-hidden.png, t10-bpr60-560px-home-caret-hidden.png,
t7c-prod-genome.png; the other files show passing interactions).

## Not verifiable here (open)
- WebKit (Tauri on macOS/Linux): only Chromium is installed.
- macOS ctrl+click: `onMouseDown` does not check ctrlKey, so on macOS ctrl+click (button 0 + contextmenu) would probably move the caret
  before the menu opens. This could not be reproduced on Linux, so it is not reported as a finding.
- Scrollbar track and thumb clicks: headless Chromium ignores them even on a plain div, so they were not tested.

## Next steps (for whoever fixes)
- Finding 1: keep the anchor base exact. Either ignore the scroll event caused by the restoring write, or keep `anchorRef.base` while
  it is still inside the top row and update only the offset. Re-test with the live-resize repro above.
- Finding 2: in extendSelectionTo, flip the direction when the new head lies on the other side of the anchor (match extendBy and drag).
- Finding 3: add a horizontal reveal of the caret x in revealRow and horizontal edge auto-scroll in dragApi.tick.
- Finding 4: build off-screen rows lazily, or reuse rows before the edit point, to bring keystrokes on large records under 16 ms.
