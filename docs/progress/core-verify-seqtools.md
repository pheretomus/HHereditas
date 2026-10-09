# core-verify-seqtools: progress log (FINAL)

## Goal
Final verification of module `seqtools` (packages/core/src/seq/{translate,codon-tables,orf,search,stats}.ts and
their tests, tools/oracle/seqtools_*.py, packages/core/test/oracle/seqtools/**), with fresh eyes:
1. run module tests + typecheck; 2. read source end to end against docs/progress/specs/core-seqtools.md;
3. probe the 5-10 riskiest behaviours on fresh inputs / oracles, promote valuable probes to permanent tests;
4. fix every provable defect with a regression test; 5. write the API summary to
docs/progress/api/core-seqtools.md.
Inputs read: _common-core.md, core-seqtools.md, seqtools.implementer-report.md, seqtools.review-findings.json
(F0..F10), seqtools.fix-report.json, core-fix-seqtools.md (fixer: all 11 fixed, 270/270 green).

## Status: COMPLETE
- `cd packages/core && npx vitest run src/seq/{translate,codon-tables,orf,search,stats}.test.ts` -> 5 files,
  279/279 green (was 270), nothing skipped (E. coli + live oracle tests ran). With src/seq/seq.test.ts: 292/292.
- `npx tsc --noEmit -p packages/core` -> 0 errors in seqtools files (remaining errors belong to other agents:
  src/primers/binding.test.ts, test/review-tmp/enzymes-verify-p3.test.ts).
- No temp files left: all test/review-tmp/seqtools-verify-*.test.ts deleted.
- NO DEFECT FOUND in the seqtools source; no source file changed. Only tests, oracle data and docs added.

## Done
- Baseline 270/270 green, tsc clean for owned files.
- Read translate.ts, orf.ts, search.ts, stats.ts, codon-tables.ts end to end against the spec (and types.ts,
  range.ts, features.ts, the GenBank parser's partialStart/partialEnd convention = low/high top-strand end,
  which is what translateFeature assumes): consistent. Circular ORF scan (virtual doubled sequence,
  longestPerStop, frame cycle when L % 3 != 0) checked by hand.
- Re-read the tests the fixers changed (MN* for table 21, /transl_table="7" -> TranslationError, pI interval
  tests): correct.
- Probes (temp, all deleted; download/export scripts lived in the session scratchpad):
  * P1 translateFeature vs FRESH NCBI records (efetch gbwithparts, exported with Biopython +
    seqtools_oracle.to_segments): 1,035 CDSs, 69 records, tables 1,2,3,4,5,6,9,10,11,12,13,22,28,33 (mito
    genomes of mouse/fly/urchin/fluke/Scenedesmus/Thraustochytrium/C. glabrata/Ciona/Cephalodiscus,
    M. genitalium, phage T4 introns + gene 60 bypass, HTLV-1/MoMLV frameshift + readthrough, SELENOP/GPX1 Sec,
    Methanosarcina Pyl, minus-strand TERM completions, 25 recent partial-cds mRNAs): ALL equal /translation.
  * P2 findOrfs vs own TS brute force: 30,000 short codon-soup cases, all 27 tables and option combos,
    30,937 ORFs (12,231 crossing the origin): exact.
  * P3 searchSequence vs own brute force: 4,000 cases (IUPAC both sides, lower case/U, palindromes, m up to L,
    k 0..3, iupac on/off): exact.
  * P4 searchProtein vs own brute force: 1,500 cases (all tables, B/Z/J/X/U/O/*, nTerminal, wrap): exact.
  * P5/P6 stats vs fresh Biopython (seed 5150; 1,500 proteins incl. 193 with pI outside [4.05,12]; 1,200
    DNA/RNA): pI default bit-identical (also lower case, trailing '*'); unbounded within 3.2e-5 of a 200-step
    root and 6.1e-5 of Biopython pi(min_=-60,max_=80); charge 3e-14; protein MW 1e-6; extinction exact;
    DNA/RNA MW (all options, 5'-OH, RNA T-as-U) 2.4e-7 Da; gc exact.
  * P7 /transl_except mapping fuzz vs an independent parent-position map: 2,621 cases (533 wrapping, 212 codons
    split by a junction, 546 TERM tails): correct.
  * P8 performance on E. coli (circular, 4.6 Mb): findOrfs 67 ms; exact 20-mer 57 ms; 2-mm 84 ms; 3-mm 123 ms;
    searchProtein 59 ms; six-frame translation 356 ms (spec: < 2 s / < 300 ms / < 3 s).
  * Oracle determinism: seqtools_oracle.main() redirected to the scratchpad reproduced all 7 JSON byte for byte.
- Promoted to permanent tests:
  * orf.test.ts 'findOrfs vs a TypeScript brute force on short codon-soup molecules (all tables)' (4000 cases);
  * search.test.ts 'search vs TypeScript brute forces on short molecules' (searchSequence 2000, searchProtein
    1000 cases);
  * translate.test.ts 'translateFeature: /transl_except lands on the intended codon (seeded random)' (2500);
  * 4 fresh NCBI records in test/oracle/seqtools/ncbi/ (NC_024511.2 Drosophila mito table 5 with TERM on both
    strands; MF374802.1 Cephalodiscus mito table 33; AF153454.1 Pyl; NM_000581.4 GPX1 Sec), provenance in the
    tools/oracle/seqtools_oracle.py docstring; oracle re-run in place: only features.json changed
    (408 -> 478 KiB); count test droppedOneBase 3 -> 8 (justified in a comment); new test pinning the
    Sec/Pyl/minus-strand TERM/table 5/33 coverage.
- API summary written: docs/progress/api/core-seqtools.md (every export, signatures, result shapes,
  coordinates/units, throws table, recipes, limitations, evidence).

## Files changed (all owned)
- packages/core/src/seq/orf.test.ts, search.test.ts, translate.test.ts (tests added; one count updated)
- packages/core/test/oracle/seqtools/ncbi/{NC_024511.2,MF374802.1,AF153454.1,NM_000581.4}.gb (new)
- packages/core/test/oracle/seqtools/features.json (regenerated)
- tools/oracle/seqtools_oracle.py (docstring only)
- docs/progress/api/core-seqtools.md (new), this log

## Open problems / decisions (for the spec owner / other teams)
- pI default (F5 vs F10): kept Biopython-equal (spec). UI must call proteinIsoelectricPoint(p,
  { interval: 'unbounded' }) to display pI (FLAG tag 3.971 instead of 4.050). Flipping needs a spec change.
- searchProtein nTerminal defaults to false (spec'd plain six-frame search); an N-terminal-peptide UI must set it.
- Shared seq/range.ts sliceRange loops forever for L = 0 and end > 0 (not our file; translateFeature guards).
- packages/viewer translate-lite.ts (UI team) uses !partialStart as "5'-complete" for every strand; for
  strand -1 the 5' end is partialEnd. Recommend injecting core translateFeature.
- No hit cap in searchSequence/searchProtein (degenerate queries on a genome -> millions of hits).

## Next steps
- None for seqtools. Integrator: wire the recipes in docs/progress/api/core-seqtools.md §7.
