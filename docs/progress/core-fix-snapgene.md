# core-fix-snapgene progress log

## Goal
Finish the review fixes for module "snapgene" (packages/core/src/io/snapgene*.ts).
Inputs: docs/progress/specs/core-snapgene.md, docs/progress/findings/snapgene.implementer-report.md,
docs/progress/findings/snapgene.review-findings.json (11 findings). No earlier fix report or log existed
when this session started (2026-10-08 ~21:42); snapgene files equalled git HEAD.
For every finding: permanent regression test + root-cause fix, or a precise rejection.

## STATUS: DONE (2026-10-08)
- `npx vitest run src/io/snapgene`: 7 files, 187 tests, all green (run twice; ~7 s).
- `npx tsc --noEmit -p packages/core`: 0 errors in snapgene files (remaining errors belong to other
  modules / other agents' temporary files).
- Temporary tests test/review-tmp/snapgene-fix-*.test.ts deleted. No git operations done.
- Oracle data regenerated with tools/oracle/snapgene_oracle.py (deterministic: re-run is identical);
  only change: new case cases/translation_ambiguous.dna (+ its cases.json entry).

## Baseline (start of session)
- 7 files, 173 tests, 2 FAIL (finding 7). tsc clean for snapgene. Oracle data in sync with its script.
- Reviewer reproductions (run as temp tests): F1-F5 already passed (fixed by the implementer after
  the review, with regression tests already present); F6, F8, F9, F10, F11 failed; F7 = the 2 red tests.

## Per finding
1. F1 readingFrame vs stale /codon_start (critical) - ALREADY FIXED (applyReadingFrame lets the
   attribute win; writer writes readingFrame; oracle script updated). Existing tests: read 'reading
   frames' (pMD20/pMD19 excerpts, case reading_frames.dna), write 'reading frames'. Added: SnapGene ->
   GenBank export test (writeGenbank emits /codon_start=2, translateFeature = SnapGene's translation).
2. F2 >65k features - ALREADY FIXED (loop appends); tests in robustness ('140 000 features/primers').
3. F3 quadratic paths a-d - ALREADY FIXED; tests in robustness ('linear time on crafted input') and text.
4. F4 invalid UTF-8 - ALREADY FIXED (decodeUtf8WithReplacements + warning); tests exist.
5. F5 warning length - ALREADY FIXED (clip); tests exist (one had a stale count, see F7).
6. F6 XMLValidator quadratic - FIXED. snapgene-markup.ts `wellFormednessError`: the validator only
   rescans whitespace in front of a nameless '=' (validator.js scanAttributeTokens restart), and only
   checks that whitespace exists, so it runs on a copy with each whitespace run before '=' shortened to
   its first char (same verdict, linear); error positions (incl. "opened in line X, col Y") mapped back.
   Timing harness over 24 hostile patterns showed this was the only super-linear path (parser linear).
   Tests: text 'XML well-formedness check' (20 000-case seeded differential test vs XMLValidator on the
   unmodified text: identical verdicts and positions; hand-checked positions; 250 KB runs) and
   robustness 'long whitespace runs in front of a "="' (27 ms; was 9.4 s at 100 KB, ~60 s at 250 KB).
7. F7 red suite - FIXED (stale expectations): robustness count test now asserts per-file counts
   [1,2,1,1,1,1,2,2,1] (the 12 warnings are all legitimate; 11 was an arithmetic slip);
   testkit.compareRecordWithBiopython takes the oracle entry and, for files with >1 Notes packet,
   tallies documented deviation 'notes-merged' instead of comparing the division (Biopython keeps the
   last packet's division; merging is our documented design). Oracle summary asserts exactly 1 such file.
8. F8 silent losses in writer - FIXED. buildNotesXml(record, now, warnings) accounts for every
   meta.extras key and reports: GenBank VERSION, KEYWORDS, SOURCE, other header lines (with their
   keywords), extras.References (summary, not written back), other unwritten extras (e.g.
   genbank.moleculeType/taxonomy), malformed UUID/Created/Created.UTC, non-3-letter division.
   buildFeaturesXml reports reverse colours that differ from the colour written. Also fixed (same root
   cause, found while there): an edited meta.division was overridden by stale extras Type/SequenceClass.
   Tests: write 'metadata it cannot store is reported, the rest survives' (6 tests); GenBank integration
   test now compares metadata (checkMeta) and reverse colours; its dropped-segment check made
   segment-specific. Fixture round trip / 'keeps the SnapGene fields' now expect exactly the References
   warning for pFA-KanMX4.dna (the old [] expectation encoded the silent loss).
9. F9 0-based positions in writer warnings - FIXED: 1-based (given segment "start+1..end", empty
   "p^p+1"/"L^1", written range via seq/range formatRange e.g. "written as 91..10"), precise reasons
   (linear reversed "ends before it starts", circular reversed "taken to run through the origin",
   "longer than", "starts outside 1..L", "extends beyond"). Old test expectations in 0-based form
   updated (DEVELOPMENT.md section 5: user-visible positions are 1-based). New test with all branches.
10. F10 Notes names the parser rejects/renames - FIXED: isStorableNotesName (XML name, no "xml" prefix,
   not in fast-xml-parser's criticalProperties/DANGEROUS_PROPERTY_NAMES); such fields are skipped with
   a warning. Tests: reviewer case (description/organism/accession survive), all names as elements and
   attributes, and a check of the list against the parser on ~100+ candidate names.
11. F11 '?' in /translation - FIXED: '?' -> 'X' (INSDC); oracle mapping + new handmade case
   translation_ambiguous.dna (fwd, split, reverse); read test cross-checks translateFeature.

## Remaining concerns (not findings; documented)
- Multi-line comments are stored as HTML, so runs of spaces/indentation are not kept (now stated in
  the snapgene.ts module docs, not warned); qualifier values with line breaks read back with spaces.
- meta.date becomes the save date (LastModified); deliberately not warned (would fire on every save).
- F6 fix and NAMES_THE_PARSER_ALTERS depend on fast-xml-parser 5.11.2 internals; the differential,
  timing and name-list tests will flag a behaviour change after an upgrade. The validator (unchanged
  verdicts) silently accepts a nameless '=' in a tag, more lenient than XML 1.0 / expat.
- Writer output still unverified in real SnapGene (implementer report).

## Next steps (for whoever continues)
- None required for this module. Optional: write SnapGene <References> from GenBank REFERENCE blocks
  instead of only reporting them; keep structured References on read so they can be written back.
