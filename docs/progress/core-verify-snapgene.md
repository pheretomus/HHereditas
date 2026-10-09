# core-verify-snapgene progress log

## Goal
Final verification (fresh eyes) of module "snapgene" (packages/core/src/io/snapgene*.ts, tests,
tools/oracle/snapgene_*.py, packages/core/test/oracle/snapgene/**):
1. run module tests + typecheck; 2. read source end to end against docs/progress/specs/core-snapgene.md;
3. independently probe the 5-10 riskiest behaviours (temp tests under
   packages/core/test/review-tmp/snapgene-verify-*.test.ts, deleted at the end; promote valuable probes);
4. fix every provable defect with a regression test; 5. write the API summary to
   docs/progress/api/core-snapgene.md.
Inputs read: _common-core.md, core-snapgene.md, snapgene.implementer-report.md,
snapgene.review-findings.json (11 findings), core-fix-snapgene.md (fixer says DONE, 187/187 green).

## Done so far
- (22:20) Read spec, reports, findings, fix log. No predecessor verify log existed.
- Baseline: `npx vitest run src/io/snapgene` 7 files 187/187 green; tsc: 0 errors in snapgene files.
- Read all source end to end (+ Biopython SnapGeneIO.py: reverses Segment order for strand -1, i.e. the
  file lists top-strand order, as our reader assumes).
- Probe 1 (DONE, clean): 1000 fresh random files from the oracle's independent Python generator (seeds
  1, 77, 4242, 99991; scratchpad only) -> reader == independent mapping for every record; 3401/3401
  feature locations == Biopython; every qualifier difference classified as a documented deviation.
- Probe 2 (DONE): single-mutation records through write -> read, listing silent changes. Found:
  * DEFECT A (fixed): segment names (Biopython-style /parts) were written raw although the reader renders
    them as rich text: "<b>x</b>" read back "x", "x<br>y" -> "x y", "<html>" vanished (parts lost).
    Fix: snapgene-features.ts buildFeatureXml encodes segment names like every other name.
    Test: write 'keeps segment names that look like markup (verification defect ...)' (fails on old code).
  * DEFECT B (fixed): text changes were silent although `SnapGeneWriteResult.warnings` promises
    "everything that could not be represented exactly": line breaks in one-line fields -> spaces;
    multi-line comments (stored as HTML) lose runs of spaces/indentation (6 GenBank fixture records,
    e.g. structured comments, DS830848 double spaces); HTML-looking values lose runs of blanks.
    Fix: markup `readsBackAsWritten` + `storeOneLine`; builders collect labels of changed fields;
    writeSnapGeneWithWarnings emits ONE aggregated warning ("N text value(s) lose line breaks or
    spacing in the SnapGene file: ... (labels, first 5)"). Precise: only when the reader's own
    rendering of the stored value differs (CRLF->LF and blanks at the ends are not reported).
    Tests: 3 new write tests + GenBank integration test asserts changed comments are reported.
    Module docs (snapgene.ts header) updated.
- Probe 3 (DONE): GenBank fixtures through SnapGene: only comments change (6 records); NC_005816 drops 3
  `variation` features at between-positions (5933^5934, 8529^8530): legit, warned.

## Current state
- `npx vitest run src/io/snapgene`: 7 files, 191/191 green. tsc: 0 snapgene errors.
- Temp files: test/review-tmp/snapgene-verify-{p1,p2,p3,dbg}.test.ts (delete at the end);
  scratchpad .../scratchpad/snapgene-verify/ (fresh.json, fresh_corpus.py).
- NOTE: genbank.ts is edited concurrently by another agent (was briefly throwing TypeError at 22:30);
  if snapgene-genbank.test.ts fails, re-run before blaming snapgene.

## Open problems / decisions
- Not changed (documented design): reader collapses whitespace in HTML (also &nbsp; runs), unlike a
  browser for NBSP; SnapGene's own display may differ. Cosmetic; now reported on write.

## Next steps
- Probe 4: hostile-input timing on new patterns (deep nesting, DOCTYPE, many attributes, entities).
- Probe 5: real-file Feature attributes (geneticCode? translationNumberingStartsFrom?) that may affect
  translation; check sgffp spec / PlasmidPop.
- Probe 6: live Biopython read of writer output for adversarial records (segment names, etc.).
- Then API doc docs/progress/api/core-snapgene.md, delete temp files, final run.
