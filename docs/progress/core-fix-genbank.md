# core-fix-genbank: progress log

## Goal
Finish the review fixes for module "genbank" (packages/core/src/io/genbank*.ts, fasta.ts, location.ts).
For each of the 16 findings in docs/progress/findings/genbank.review-findings.json: permanent regression
test + root-cause fix, or a precise rejection. End with the module's whole test suite green and a clean
typecheck for the owned files.

## STATUS: DONE (2026-10-08 22:07 KST)
- Module suite: `cd packages/core && npx vitest run src/io/genbank.test.ts src/io/genbank-oracle.test.ts
  src/io/genbank-roundtrip.test.ts src/io/genbank-property.test.ts src/io/genbank-large.test.ts
  src/io/genbank-scale.test.ts src/io/fasta.test.ts src/io/location.test.ts` -> 8 files, 298/298 passing
  (baseline was 283; live Biopython tests and the E. coli tests ran: venv and large fixture present).
- tsc: 0 errors in owned files (1 remaining error, in src/ops/ops.regression.test.ts, belongs to another agent).
- All 20 reviewer reproductions (all 16 findings) were run verbatim from a temp file: all pass.
- Extra temp checks (deleted): a stray line inserted at every position of every fixture's feature table
  (4488 cases) never lost a feature; 8583 fuzzed records: no throw, valid segments, writer output is a
  fixed point, sequence and feature count preserved by write -> read.
- Temp files packages/core/test/review-tmp/genbank-fix-*.test.ts deleted (other agents' files untouched).

## Baseline (start of this session, 21:44)
- No predecessor log and no genbank.fix-report.json existed.
- 283/283 tests passing; tsc errors only in other modules.
- Predecessors had already added src/io/genbank-text.ts (splitTextLines strips BOMs on every line;
  appendAll replaces unbounded `push(...spread)`), a findUnlabelledSequenceBlock recovery for a lost
  ORIGIN keyword line, linear-time location assembly, the FASTA regex fix, and the inner-fuzzy /
  inward-marker warnings in location.ts, each with regression tests (genbank-scale.test.ts etc.).

## Status per finding (index = position in the review JSON)
| # | finding | status |
|---|---------|--------|
| 0 | spread RangeError (reader/writer) | already fixed (genbank-scale.test.ts) |
| 1 | quadratic multi-line location | already fixed (genbank-scale.test.ts 'linear-time reading') |
| 2 | FASTA BOM before later '>' | already fixed (fasta.test.ts) |
| 3 | FASTA TOPOLOGY_MODIFIER ReDoS | already fixed (fasta.test.ts) |
| 4 | GenBank BOM before later LOCUS | already fixed (genbank.test.ts) |
| 5 | inner fuzzy lost at origin merge | already fixed (location.test.ts, genbank.test.ts) |
| 6 | = #0 (duplicate) | already fixed |
| 7 | = #1 (duplicate) | already fixed |
| 8 | = #5 (duplicate) | already fixed |
| 9 | '>a..b' / 'a..<b' direction silently flipped | already fixed (warning; location.test.ts, genbank.test.ts) |
| 10 | circular span ending after L wraps instead of clamping | FIXED: resolveSpan clamps (+partialEnd, warning) on both topologies |
| 11 | one unindented line in FEATURES drops later features | FIXED (see below) |
| 12 | CONTIG line lost, N placeholder written as sequence | FIXED (see below) |
| 13 | ORGANISM indented by 4 blanks swallowed into SOURCE | FIXED: headerKeyword accepts the 8 sub-keywords after 4-11 blanks |
| 14 | NaN/undefined seqLength gives NaN coordinates | FIXED: parseLocation -> {ok:false, error}, formatLocation -> '' |
| 15 | /translation wrap splits an escaped "" pair | FIXED: findBreakAnywhere never ends a non-final line with '"' |

## Details of the fixes made in this session
- #15 genbank-features.ts: findBreakAnywhere. Tests: genbank.test.ts (every quote position 30..129, runs
  of 1-3 quotes, a quotes-only value) + live Biopython check in genbank-property.test.ts (300 files).
- #14 location.ts: moleculeLength(). Test: location.test.ts 'never produces NaN coordinates ...'.
- #10 location.ts resolveSpan. Tests: location.test.ts table rows + 'clamps a span ending after base L ...',
  genbank.test.ts truncated circular record (featureSequence 'CGGGGGGGGGG' like Biopython's extract).
  CHANGED EXISTING TESTS (justified): the table rows '90..120' / '90..250' on circular L=100 expected the
  wrap ({89,120} / {89,189}); that is exactly the defect: spec says "Positions beyond the sequence ->
  warning and clamp or drop" and parseLocation's TSDoc says clamped + partial. Now {89,100}, partialEnd.
  No fixture is affected (checked the oracle JSON: no circular feature ends past L).
- #13 genbank-header.ts headerKeyword + SUB_KEYWORDS. Test: genbank.test.ts header. Biopython checked in
  the venv: reads the 4-blank form identically; with 5+ blanks it truncates the keyword (we stay correct).
- #11 genbank.ts: the table now ends only at FEATURE_TABLE_END (ORIGIN, CONTIG, BASE COUNT, WGS,
  WGS_SCAFLD, TSA, TLS). genbank-features.ts: column-1 lines (not starting with '/') are flagged
  `unindented`: read as the continuation of an open quoted value, or of an open location when they look
  like location text (location characters + a digit), otherwise ignored; a warning in every case; they
  never end the feature. FEATURES indented by 1-3 blanks is accepted (the "related" case of the finding).
  Tests: genbank.test.ts (reviewer F1 + F1b pBR322, raw-newline value/location, stray inside a location,
  indented FEATURES) + seeded robustness test (300 random stray insertions).
- #12 genbank.ts/genbank-header.ts: GENBANK_EXTRA_KEYS.contig = 'genbank.contig' holds the CONTIG text
  (joined like Biopython's annotations['contig']); a repeated CONTIG section is warned and ignored.
  writeGenbank writes the CONTIG section (wrapped after commas, <= 80 cols) and NO ORIGIN while the
  sequence is only the N/X placeholder (Biopython's behaviour; lossless since re-reading gives the same
  placeholder), and CONTIG + ORIGIN otherwise. compare.ts now also compares the CONTIG text with
  Biopython (static oracle + both live tests). Tests: genbank.test.ts (DS830848, multi-line CONTIG,
  edited sequence, repeated CONTIG), genbank-scale.test.ts (10 Mb CON record written in < 1 KB).
  CHANGED EXISTING TEST (justified): genbank-roundtrip.test.ts asserted "re-reading the written fixture
  gives no warnings"; for the 3 CONTIG fixtures that assertion encoded the defect (the placeholder became
  indistinguishable from real sequence). It now expects exactly the CONTIG placeholder warning for them
  (rereadWarnings) and a new test pins which fixtures those are.

## Remaining concerns / notes for the integrator
- #11: text that lands inside an open quoted value is read into the value (with a warning): a stray line
  there cannot be told from a raw line break inside the value.
- #12: the CONTIG text stays in meta.extras when the sequence is edited; it is then written before ORIGIN
  (like the verbatim REFERENCE ranges, it may be stale). Editing operations (ops module) could drop
  extras['genbank.contig'] when they change the sequence.
- #14: formatLocation returns '' for an unusable length; writeGenbank always passes seq.length (finite).
- No shared-model change needed (CONTIG lives in meta.extras like taxonomy and the LOCUS molecule token).

## Next steps
- None for this module.
