The GenBank, FASTA and location module is done. All 252 tests in my 7 test files pass in about 1.3 s, including the 4 live Biopython tests, and my files typecheck with no errors. Biopython 1.88 reads the fixtures the same way we do, apart from 5 documented features and 2 file-level cases. No sudo or extra dependencies were needed, and I did not touch git.

FILES
- `packages/core/src/io/`: `genbank.ts`, `fasta.ts`, `location.ts`, plus helpers `genbank-locus.ts`, `genbank-header.ts`, `genbank-features.ts`, `genbank-sequence.ts`, `genbank-colors.ts`.
- Tests in `packages/core/src/io/`: `location.test.ts`, `genbank.test.ts`, `genbank-oracle.test.ts`, `genbank-roundtrip.test.ts`, `genbank-property.test.ts`, `genbank-large.test.ts`, `fasta.test.ts`.
- `tools/oracle/genbank_oracle.py` and `tools/oracle/genbank_fasta_oracle.py`. Both are seeded; regenerating gives byte-identical output.
- `packages/core/test/oracle/genbank/`:
  - `biopython/*.json`: one file per fixture, plus a compact summary for the E. coli genome. The largest is 740 KB.
  - `fasta_cases.json`: 300 seeded cases.
  - `compare.ts`, `deviations.ts`, `random-records.ts`: test helpers.

PUBLIC API
- `parseGenbank(text: string): ParseResult`
- `writeGenbank(record: SeqRecord, options?: GenbankWriteOptions): string`
  - `GenbankWriteOptions { colorQualifiers?: boolean; date?: string }`
- `GENBANK_EXTRA_KEYS = { moleculeType: 'genbank.moleculeType', taxonomy: 'genbank.taxonomy' }`
- `parseFasta(text: string): ParseResult`
- `writeFasta(records: SeqRecord | readonly SeqRecord[], options?: FastaWriteOptions): string`
  - `FastaWriteOptions { lineWidth?: number }`. Default 70; 0, a negative number or Infinity means no wrapping.
- `parseLocation(text: string, seqLength: number, topology: Topology): LocationParseResult`
  - `{ ok: true; strand: Strand; segments: Range[]; partialStart: boolean; partialEnd: boolean; warnings: string[] } | { ok: false; error: string }`
  - The strand is always 1 or -1; the GenBank reader sets 0 on protein records.
- `formatLocation(loc: LocationLike, seqLength: number, topology: Topology): string`
  - `LocationLike { strand; segments: readonly Range[]; partialStart?; partialEnd? }`
- The helper modules export their building blocks (`parseLocusLine`, `formatLocusLine`, `normalizeColor`, `cleanResidues`, and so on). For `io/index.ts` I suggest re-exporting only the items above.

TESTS: 252 in 7 files.
- **Location:** an 82-row table covering every form, 18 rejected inputs, a depth guard (100,000 nested levels are rejected cleanly), and a 20,000-part join parsed in linear time. Two seeded properties of 5,000 cases each check that format then parse gives back the input, and that parse then format is stable.
- **GenBank unit and robustness:** 68 tests, including 400 random line-level corruptions of the fixtures and 200 random-character inputs. The parser never throws and always returns valid records.
- **Round trips:** for all 31 fixtures and the multi-record cor6_6 file, parsing what we wrote gives back the first parse (ids ignored). Writing that again gives byte-identical text, and re-reading it produces no warnings. When the original lacked a date, division or molecule type, the first write fills in a default (`options.date`, SYN, or the molecule type); the test accounts for that.
- **Random records:** 400 seeded random records go through write then parse unchanged and stay within the line widths. Temporary stress runs with 5 more seeds × 3,000 records also passed.
- **E. coli genome:** parses in about 0.15–0.35 s and writes in about 0.3 s, against the 3 s limit. The test skips if the file is absent.
- **FASTA:** 14 tests, including 300 Biopython cases, a live writer check and 500 seeded property cases.

ORACLE AGREEMENT (Biopython 1.88)
- **Fixtures:** all 31 files and 36 records agree on name, description, sequence, topology, molecule type, header fields, feature types, every location and every qualifier value. The exceptions are the 5 features and 2 file-level cases listed below.
- **E. coli genome:** all 9,285 features match on type, location and qualifier checksum, and the sequence checksum matches.
- **Live checks:**
  - Biopython reads all 36 written fixture records exactly as it reads the originals, apart from the documented cases, and exactly as our own reader reads them.
  - The same holds for 150 seeded random records, and for 4,000 more in temporary stress runs.
  - Biopython reads the 100 FASTA files we wrote back to the same records.
- **FASTA:** all 300 cases match Biopython.

DELIBERATE DEVIATIONS (each documented in `test/oracle/genbank/deviations.ts` or the test)
- **Start after end on a linear record:** Biopython drops the location. We read it as join(start..L,1..end) with a warning. This affects `bad_origin_wrap_linear.gb` and the addgene-11664 enhancer.
- **Negative start position:** Biopython drops the location. We clamp to base 1, mark the start partial and warn (`negative_location.gb`).
- **Mixed strands in one join:** we use the majority strand, with a warning. Ties take the strand of the first written part.
- **Feature entirely beyond the sequence:** we drop it with a warning; Biopython keeps it (`qualifier_escaping_read.gb`).
- **`no_origin_no_end.gb`:** Biopython raises an error. We return the record with an N placeholder and warnings.
- **Representation differences:**
  - Origin-spanning features are merged into one segment.
  - References to other entries (e.g. `AB123.1:10..20`) are skipped with a warning.
  - `one-of(...)` positions take the first alternative, with a warning. Biopython uses the lowest for a start and the highest for an end.
  - `order()` and `bond()` become join, with a warning.
  - `<` or `>` markers on inner parts of a join are dropped, with a warning.
  - Value-less qualifiers like `/pseudo` keep the value null, and repeats are kept.
  - A missing topology means linear.
  - CONTIG-only records get an N placeholder; Biopython leaves the sequence undefined.
  - The LOCUS molecule type is read by tokens: we report `ds-DNA` where shifted columns make Biopython report `DNA`.
  - A blank division is left empty.
  - SOURCE is kept verbatim.
  - Structured comments and blank comment lines are kept.
- **FASTA:** tabs, digits and gap characters are removed from sequences (Biopython keeps tabs). The description excludes the identifier. `[topology=circular]` is parsed.

KNOWN LIMITATIONS
- Some information is lost on a GenBank-to-GenBank round trip, always with a warning at read time: order/bond operators, references to other entries, and inner fuzzy markers.
- Partial ends follow the written text: partialStart means `<` on the left, whatever the strand.
- Nucleotide features with strand 0 are written without complement() and read back as strand 1.
- Some lines can run long:
  - Qualifier values containing a word longer than 58 characters overflow column 79 rather than being split.
  - COMMENT lines longer than 68 characters are re-wrapped.
  - Newlines in qualifier values are written as spaces.
- Non-ASCII characters are written as UTF-8; GenBank officially allows only ASCII 32–126.
- Neither primers nor sticky ends are written.
- An organism name containing `;` would be read back as part of the taxonomy.
- An N placeholder is only created up to 2^28 bases; beyond that the sequence is left empty with a warning.
- Locus names longer than 16 characters push the other LOCUS fields to the right. That is allowed (GenBank release notes 3.4.4.1), but Biopython then loses the molecule type and topology of protein records.

REQUESTED CHANGES TO SHARED FILES
- **`Feature`:** an optional location operator (join, order or bond), per-segment fuzzy flags and a field for references to other entries. These would make GenBank round trips lossless.
- **`RecordMeta`:** dedicated `taxonomy` and LOCUS molecule-type fields. For now they live in `meta.extras` under `genbank.taxonomy` and `genbank.moleculeType`.