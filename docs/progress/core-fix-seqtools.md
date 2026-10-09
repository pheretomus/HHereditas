# core-fix-seqtools: progress log (FINAL)

## Goal
Finish the review fixes for module `seqtools` (packages/core/src/seq/{translate,codon-tables,orf,search,stats}.ts).
Inputs: docs/progress/specs/core-seqtools.md, findings/seqtools.review-findings.json (11 findings, F0..F10 by
array index), findings/seqtools.fix-report.json (first fixer: F0..F6 fixed, 253 tests).
For every finding: permanent regression test + root-cause fix, or a precise rejection. End with green suite +
clean tsc for owned files.

## Status: COMPLETE
- `npx vitest run src/seq/{translate,codon-tables,orf,search,stats}.test.ts` -> 5 files, 270/270 passed
  (E. coli genome tests and live Python oracles ran, not skipped).
- `npx tsc --noEmit -p packages/core` -> 0 errors in owned files (8 remaining errors are in other agents'
  files: src/gel/ladders.test.ts, src/io/genbank.test.ts, src/ops/ops.regression.test.ts).
- Oracle determinism: re-running tools/oracle/seqtools_oracle.py (into the scratchpad) reproduces all 7 JSON
  files byte-for-byte. No oracle data changed.
- No temp files left in packages/core/test/review-tmp (the files there belong to the primers/snapgene agents).

## Baseline found (session start)
- 11 failed / 256 passed (267). tsc errors in owned files: search.test.ts (nTerminal unknown option),
  stats.test.ts:299 (proteinIsoelectricPoint takes 1 arg), translate.ts:235 (CHAR_M unused).
  A second fixer (no log) had added tests for F7..F10 and half-applied F8 (initiator table compiled).

## Per finding
- F0 zero-length circular segment beyond L: already fixed (checkSegments); test passes.
- F1 / F6 searchProtein U/O never match: already fixed (U=TGA, O=TAG); tests + oracle pass.
- F2 protein toUpperCase ('ß'): already fixed (ASCII-only folding); tests pass.
- F3 baseCounts digit key order: already fixed (docs; Record order is fixed by ECMA-262, return type is spec'd).
- F4 trailing partial codon (NCBI N-padding): already fixed; tests + 18 NCBI records pass.
- F5 pI clamped to [4.05,12]: fixed as opt-in `proteinIsoelectricPoint(p, { interval: 'unbounded' })`; the
  default stays Biopython's (spec). TSDoc warns that a default result within 1e-4 of 4.05/12 means
  "at or beyond". Spec owner may flip the default; that needs a spec change.
- F7 /transl_table: fixed. integerQualifier(): plain decimal only (trim, leading zeros ok); '', blanks, sign,
  fraction, exponent, hex, value-less (null), conflicting repeats -> TranslationError naming the feature;
  unknown table id in the qualifier -> TranslationError naming feature and value; options.table unknown ->
  RangeError. Same root cause also fixed for a value-less /transl_except.
- F8 ambiguous initiator: fixed (predecessor's `initiator` table kept, CHAR_M removed, TSDoc updated).
  Verified against a literal TS port of NCBI CTrans_table::x_InitFsaTransl on ncbi_gc.prt: 38047 agree,
  193 mixed-start pairs now X (= review count), only documented deviations (21:ATR = M; 20 context-stop
  codons in tables 27/28/31 = their amino acid; NCBI '-' for non-starts = amino acid here).
- F9 searchProtein alt start: fixed as `nTerminal` option (default false, keeps the spec's 6-frame semantics).
- F10 pI vs Biopython: fixed; default == Biopython isoelectric_point() < 1e-9 on all 400 + 60 oracle proteins.

## Test changes to predecessor tests (justified)
- translate.test.ts: 'ATRAAATAA' table 21 cds expectation 'MK*' -> 'MN*' (AAA = Asn in table 21; Biopython
  translate gives 'MN*'). Typo in the expected value, the F8 point of the line (ATR -> M) is unchanged.
- translate.test.ts 'validates the record...': /transl_table="7" -> RangeError was exactly the F7 defect and
  contradicted the predecessor's F7 test (which lists '7'); now TranslationError, plus options.table 7 ->
  RangeError.
- stats.test.ts: the F5-era tests asserted that the DEFAULT returns the unclamped root, contradicting the spec
  and the F10 test; they now pass `{ interval: 'unbounded' }` (same assertions) and additionally assert the
  default equals Biopython's bound. The stats.json test now also checks default == Biopython for every protein.

## New tests added
- translate: NCBI start-residue consensus port (all tables x 3375 codons); value-less /transl_except.
- search: brute-force completeness of nTerminal hits (60 seeded cases, both strands, circular wrap).
- stats: interval option validation.
- parseGcPrt moved from codon-tables.test.ts into test/oracle/seqtools/oracle.ts (shared by two tests).

## Files changed (all owned)
packages/core/src/seq/{translate,search,stats}.ts, {translate,search,stats,codon-tables}.test.ts,
packages/core/test/oracle/seqtools/oracle.ts, packages/core/src/seq/index.ts (appended one line:
`export type { IsoelectricPointOptions } from './stats';`).

## Open problems / decisions for the spec owner
- pI default (F5 vs F10): kept Biopython-equal per the spec; recommend the UI call with
  `{ interval: 'unbounded' }` when displaying pI.
- searchProtein `nTerminal` defaults to false; a UI "N-terminal peptide" checkbox should set it.
- Still open from the first fixer: seq/range.ts sliceRange loops forever for L === 0 with end > 0 (shared file,
  not owned); translateFeature guards against it, other callers do not.
