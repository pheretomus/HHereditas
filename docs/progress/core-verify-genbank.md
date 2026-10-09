# core-verify-genbank: progress log

## Goal
Final verification of module "genbank" (packages/core/src/io/genbank*.ts, fasta.ts, location.ts and their
tests, tools/oracle/genbank_*.py, packages/core/test/oracle/genbank/**), with fresh eyes:
1. run the module's tests and the typecheck;
2. read the source end to end against docs/progress/specs/core-genbank.md;
3. probe the 5-10 riskiest behaviours on fresh inputs (quick tests / Biopython oracle), promote valuable probes;
4. fix every provable defect with a regression test;
5. write the downstream API summary to docs/progress/api/core-genbank.md.

## Done so far
- (start) Read _common-core.md, core-genbank.md spec, implementer report, fix log (core-fix-genbank.md),
  all 16 review findings (genbank.review-findings.json).
- Baseline run (22:09): 8 test files, 298/298 pass (live Biopython + E. coli tests ran). tsc: errors only in
  src/ops/ops.regression.test.ts and src/ops/qualifiers.ts (other agent), none in genbank files.
- Read end to end: genbank.ts, location.ts, genbank-features.ts, genbank-header.ts, genbank-locus.ts,
  genbank-sequence.ts, genbank-text.ts, genbank-colors.ts, fasta.ts, test/oracle/genbank/compare.ts,
  deviations.ts; skimmed the test inventory.

- Probe A (location vs Biopython Location.fromstring, 4000 random in-range locations, both topologies,
  joins/order/nested complement/origin merges/sites/inward markers): segments + strand agree in 4000/4000.
  Only difference: single fuzzy base '<n' / '>n' (Biopython marks BOTH boundaries fuzzy; ours marks the
  side the marker points to; pinned by location.test.ts table rows; no coordinate impact). With single
  fuzzy bases excluded: 4000/4000 identical incl. partial flags. Helper written:
  tools/oracle/genbank_location_oracle.py (candidate for a permanent live test).
- Probe B (300 adversarial written records -> Biopython): 0 diffs Biopython vs our reader, 0 diffs original
  vs re-read, 0 warnings either side. Only lines > 80 cols from unbreakable 58+ char tokens (documented).
- Probe C (37 malformed qualifier/location layouts): reader agrees with Biopython wherever Biopython
  gives a result; differences are documented choices (repeated value-less kept, remote parts skipped,
  '2.6' and upper-case operators accepted, key line without location accepted). Unterminated quoted
  value keeps its opening quote: identical to Biopython 1.88 feature_qualifier (strips quotes only when
  both present) -> not a defect.
- Probe E (486 LOCUS lines written, read by Biopython): all fields exact while name+1+length <= 28;
  beyond, Biopython's token fallback loses the molecule token / protein topology (documented limitation).
  Our reader: 486/486 exact, no warnings.

- Probe F (20000 non-normalized integer segment sets -> formatLocation -> parseLocation): 0 problems.
- Probe D (8 synthetic header layouts incl. odd block orders, NID/PROJECT/DBSOURCE/SEGMENT/PRIMARY,
  unknown keyword, structured comment; Biopython reads original and our rewrite identically): 0 diffs.
- Probe G (FASTA): already covered by 300 Biopython cases + properties; only a contrived issue noted
  (linear record whose description contains the literal text '[topology=circular]' reads back circular).
- Probe H: DEFECT FOUND (regression of the #11 fix). A feature key line written in column 1, e.g.
  'CDS             5..12' after '     rep_origin      1..4', is ignored ("unindented line ... ignored")
  and the qualifiers after it (/gene="bla", /product=...) are attached to the PREVIOUS feature: the
  rep_origin is renamed 'bla'. Silent misannotation of another region. Biopython drops the misplaced
  feature (or fails), never misattributes.

- FIXED probe H (genbank-features.ts): KNOWN_FEATURE_KEYS (cited), columnOneKeyLine(), columnOneBlock();
  buildRawFeature/readQualifiers return the next FeatureBlock when the body holds a column-1 key line;
  readFeatureTable loops over such splits. Only lines the reader would otherwise IGNORE are affected
  (never continuations of an open quoted value / location). Inside an unfinished location only the
  unambiguous 'key location' form splits. Malformed-escaping rule extended: a value line ending with '"'
  ends the value when a column-1 key line follows (like a '/' line; Biopython ends at any quote).
  Tests: genbank.test.ts 'reads a feature key line written in column 1 as a new feature ...' (fails on
  the old code: rep_origin named 'bla'; verified by temporarily disabling the recogniser) and property
  'reads every feature key line of every fixture moved to column 1 like the original' (312 cases).
  parseGenbank TSDoc updated.

## Current state
- Module suite green (299 + new property = 300 expected); tsc clean for owned files.

## Open problems / decisions
- none yet

## Probe plan (riskiest behaviours, fresh inputs)
- A: parseLocation vs Biopython Location.fromstring on random in-range locations (coverage/strand/partials).
- B: writeGenbank output read by Biopython: adversarial qualifier values, keys, partial/wrapping locations.
- C: reader vs Biopython on malformed-but-plausible qualifier layouts (unterminated, lone quote, '/' lines).
- D: header round trip via Biopython (REFERENCE, long ORGANISM, COMMENT, KEYWORDS, DEFINITION periods).
- E: LOCUS line variants vs Biopython (long names, tokens, protein).
- F: formatLocation on non-normalized segments; parse(format(x)) coverage.
- G: FASTA edge cases.

## Next steps
- Run probes A-G; fix proven defects with regression tests; write docs/progress/api/core-genbank.md.
