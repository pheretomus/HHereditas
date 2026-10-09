# Cloning wizards UI progress log

## Goal
Cloning wizards in apps/desktop/src/features/cloning/: PCR, Restriction cloning, Gibson (primer design +
NEBuilder amounts), Golden Gate. Live previews, create product as new document with a provenance comment.
Wire into menus/commands/toolbar (replace "Cloning (coming soon)"). Vitest + Playwright e2e (port 5402).

## Done
- Pure models in features/cloning/model/: common.ts (sources = open documents or their selections,
  provenance comment, gel lanes, annotatePieces, withoutPrimerFeatures), pcr.ts, restriction.ts, gibson.ts,
  goldenGate.ts.
- Sheets: PcrSheet, RestrictionSheet, GibsonSheet (Design Primers / Join Fragments; Product, Primers and
  DNA Amounts panels), GoldenGateSheet. Shared pieces: ProductPreview + Issues, MoleculePicker (open
  documents, selections, Open File… which keeps the vector active), FragmentList (reorder, reverse, remove),
  CloningSheet.module.css.
- Wiring: store SheetId gained clone-pcr | clone-restriction | clone-gibson | clone-golden-gate;
  DocumentWindow onAction opens them; the toolbar Actions > Clone submenu is enabled (cloningAvailable
  defaults to true); macOS Tools menu got the 4 items instead of "Cloning (coming soon)"; App renders
  <CloningSheets/>.
- Behaviour details:
  - PCR: primers come from the selection (20 nt at each end), else from saved primers that bind each
    strand. Shows the annealed length, position, Tm and tail. Gel thumbnail with the NEB 1 kb Plus ladder.
    Handles several products. Option to save typed primers to the template.
  - Restriction: the enzyme list shows cuts in the vector and in the insert. It starts with a suggested
    pair, scored by warnings, then 4-nt sticky ends, then the smallest vector dropout (gives BamHI+EcoRI
    for pBR322 into pUC19, ~90 ms). Fragment/orientation overrides sit in a collapsed disclosure. The
    junction summary marks sites that are not recut.
  - Gibson: insertion = vector selection (or caret). Shows the primer table, Copy Order List (TSV) and
    the junction table (overlap, Tm with out-of-range values in red, GC, sequence). NEBuilder amounts:
    vector ng, ratio, and in join mode the vector fragment. Optionally adds the designed primers to the
    template documents.
  - Golden Gate: BsaI/BsmBI/Esp3I/BbsI/PaqCI/SapI. Parts default to all open documents. Shows the order
    table with overhangs.
  - Products get a COMMENT line describing how they were made. primer_bind features that duplicate the
    product's primers are dropped, so the primers are drawn once and saving does not duplicate them.
    Assembly pieces without features are annotated as misc_feature.
- Tests: src/features/cloning/__tests__/models.test.ts (19) + suggest.test.ts (1); desktop vitest 104/104.
  e2e/cloning.spec.ts (4 tests: PCR, restriction BamHI/HindIII tet into pUC19 = 3,002 bp, Gibson design
  3,820 bp + primers added to templates, Golden Gate of 4 FASTA parts = 3,766 bp); full e2e 8/8. tsc clean.
- Screenshots: /tmp/hh-shots/cloning/ (pcr-light, pcr-dark-large, restriction-light/dark, gibson-light,
  gibsonPrimers-light, gibsonAmounts-light/dark, gibson-small (900x600), goldengate-light/dark).

## Current state
DONE. Dev server on 5402 stopped.

## Open problems / known issues
- Products open as unsaved documents. The template documents are only changed when the user opts in
  to adding primers (each insert document gets its own undo step).
- Gibson "Join Fragments" refuses whole circular documents (the engine needs linear fragments): the user
  must select a region or use Design Primers.
- No core bugs found. Observation: restrictionClone's 'auto' insert fragment prefers the longest fitting
  fragment (pBR322 BamHI/HindIII picks 4,015 bp rather than the 346 bp tet fragment); the UI exposes the
  choice under "Fragments and orientation".
- Not verified inside a real Tauri window (native Tools menu items are only type-checked).

## Next steps
- Remember the last wizard inputs per session; keyboard shortcut for PCR; agarose/ladder choice in PCR gel.
