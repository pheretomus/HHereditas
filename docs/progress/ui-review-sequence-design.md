# UI review: sequence (SequenceView) — visual design & UX critic — FINAL

## Goal
Adversarial visual/UX review of `packages/viewer/src/sequence/**` (SequenceView): every gallery story in light+dark at
900x600 and 1600x1000, zoomed details at 3-4x, interaction checks; report concrete fixable problems with evidence.
Review only (no product files modified). Port 5214 (vite stopped at the end).

## Done
- Read _common-ui.md, ui-sequence.md, implementer report, SequenceView.tsx, SequenceRow.tsx, layout.ts, translation.ts,
  CSS module, tokens.css, colors.ts, gallery + demo data.
- 84 overview shots: /tmp/hh-shots/sequence-review/<story>-<light|dark>-<900x600|1600x1000>.png (21 stories, no console
  errors). Zooms: /tmp/hh-shots/sequence-review/zoom/. Interactions: /tmp/hh-shots/sequence-review/interact/.
  Narrow widths 420/520: /tmp/hh-shots/sequence-review/narrowprobe/.
- Verified CORRECT (no finding): all checked enzyme cut positions & stepped cut marks (incl. 3'-overhang PstI/KpnI/SacI,
  Type IIS BsaI/BsmBI/SapI, cuts spanning row wraps and the origin: MluI 317, EcoRI 4,359 -> row 1), 1-based numbering,
  forward/reverse CDS translations at base level (KanR MGKEKTH, araC ...KLS*, AmpR TTA/CCA/ATG/CTT = */W/H/K), codon
  selection, primer strands/5' labels/mismatches (KanMX-F 475, Check-R), sticky-end blanking, protein & empty records,
  4.6 Mb genome story, hover/click/focus ring/caret/drag/typing/shift+arrows/Home/End/ArrowDown, resize anchoring,
  narrow layouts, no hard-coded colours.

## Findings (reported to orchestrator)
1. MAJOR stop codon '*' low contrast (dark 1.8:1, light 2.9:1) — zoom/orfs-stop-{dark,light}.png.
2. MAJOR light-theme complement strand & row numbers 3.04:1 (AA fail), multi-cutter labels 3.98:1, complement on
   selection 2.92:1; dark complement 4.02:1.
3. minor enzyme hover doesn't highlight its own cut path (KpnI/XmaI @2,308) — interact/hover-{KpnI,XmaI}-mcs-light.png.
4. minor primer 5' tail shown only as a 4 px tick (KanMX-F 10-nt tail) — zoom/primers-kanmxf-*.png.
5. minor selected codon's amino-acid cell not highlighted — zoom/translations-codon-*.png.
6. minor translation strip has no residue tooltip/number (8 hit areas, 0 <title>).
7. minor unfocused selection ~ focused (no gray unemphasized state).
8. minor feature pieces other than the widest get no outside label (pFA6a row 1 SP6 stubs; 420 px 'TEF p…').
9. minor empty-state hint 2.23:1 light / 2.90:1 dark.

## State at end
- Temporary scripts (<scratchpad>/seqdesign/) deleted; vite on 5214 stopped. Screenshots kept under
  /tmp/hh-shots/sequence-review/.

## Next steps (for the fixer)
- Fix 1 and 2 first (tokens: request --hh-seq-text-complement / --hh-seq-ruler / --hh-enzyme-multi ~0.56 alpha in light
  from the design-system agent; stop codon: dark glyph on a solid red cell or white-on-red badge).
- Then 3, 5, 6 (small changes in SequenceRow.tsx), 8 (layout.ts label placement), 4, 7, 9.
