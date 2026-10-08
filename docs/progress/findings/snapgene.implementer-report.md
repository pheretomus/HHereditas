No sudo was needed for any of this.

**Result:** the SnapGene reader and the experimental writer are done. All 144 tests in 7 files pass, my files typecheck cleanly, and nothing was added to npm (only the existing `fast-xml-parser`). One limit up front: I had no SnapGene installation, so no file written by the writer has been opened in SnapGene itself. Its output copies the files real SnapGene writes and is read correctly by Biopython and by an independent Python reader.

## Files created
- **Engine:** `packages/core/src/io/snapgene.ts` (public API) plus helpers in the same folder: `snapgene-binary.ts`, `snapgene-markup.ts`, `snapgene-sequence.ts`, `snapgene-features.ts`, `snapgene-primers.ts`, `snapgene-notes.ts`.
- **Tests** (all in `packages/core/src/io/`):

| File | Tests | What it covers |
|---|---|---|
| `snapgene-text.test.ts` | 24 | UTF-8, XML entities, HTML rich text |
| `snapgene-read.test.ts` | 40 | reader unit tests |
| `snapgene-oracle.test.ts` | 34 | comparison with Biopython and the Python reimplementation |
| `snapgene-write.test.ts` | 39 | writer |
| `snapgene-live.test.ts` | 1 | writer output read by Biopython |
| `snapgene-robustness.test.ts` | 4 | damaged and hostile input |
| `snapgene-genbank.test.ts` | 2 | GenBank → SnapGene → record |

- **Oracle:** `tools/oracle/snapgene_oracle.py`. Its `--dump` mode is used by the live test. Two runs give identical output.
- **Oracle data** in `packages/core/test/oracle/snapgene/`: `fixtures.json`, `cases.json`, `random.json` (1.3 MB), `html.json`, 30 handmade `cases/*.dna`, and the shared test helpers `testkit.ts`.

## Exported API (`snapgene.ts`)
- `isSnapGeneFile(data: Uint8Array): boolean` — checks the cookie only. It also returns true for SnapGene `.prot`/`.rna` files.
- `parseSnapGene(data: Uint8Array, options?: SnapGeneParseOptions): ParseResult` with `{ fileName?: string }`. It returns exactly one record, or none plus a warning, and never throws.
- `writeSnapGene(record: SeqRecord, options?: SnapGeneWriteOptions): Uint8Array` with `{ now?: Date }`. EXPERIMENTAL. It throws `Error` for non-DNA records and `RangeError` for an invalid `now`.
- `writeSnapGeneWithWarnings(record, options?): { data: Uint8Array; warnings: ParseWarning[] }` — an addition beyond the spec. It reports everything the format cannot store; `writeSnapGene` returns only its `data`.
- `SnapGeneExtraKey` (Strandedness, DamMethylated, DcmMethylated, EcoKIMethylated, UpstreamModification, DownstreamModification) and `REFERENCES_EXTRA_KEY = 'References'`.

The helper modules export internals for these files and the tests only. `io/index.ts` should re-export from `./snapgene` alone.

## Oracle agreement (Biopython 1.88)
- **Independent mapping:** for every input (8 fixtures, 30 handmade cases, 120 seeded random files), our record exactly equals what the Python reimplementation expects (expat XML parser, `html.parser`). The same holds for all 70 files our writer produced in the live test.
- **The 8 real fixtures:** sequence and topology identical, 25/25 feature locations identical, and 62 of 66 qualifier values identical. The other 4 are documented deviations: 3 `/translation` clean-ups and 1 inserted `/label`.
- **All 146 files Biopython accepts** (Biopython rejects 9 malformed cases): 482/482 feature locations identical (minus-strand, origin-wrapping and gapped features included). Of 2,186 qualifier values, 1,155 are identical; all other differences are classified by documented reason, with 0 unexplained:

| Reason | Count |
|---|---|
| HTML rendered | 379 |
| Repeated `<Q>` elements | 322 |
| Vocabulary prefix kept (`GI:…`) | 93 |
| `/translation` clean-up | 68 |
| Name inserted as first `/label` | 67 |
| Value-less qualifier | 60 |
| Plain text with `<…>` kept | 29 |
| readingFrame → `/codon_start` | 12 |
| Empty value | 1 |

- **Live test** (our writer → Biopython): 70 files, 0 Biopython errors, 261/261 locations identical, 900 values identical, the rest documented.
- **Text layer:** the HTML entity decoder matches Python's `html.unescape` on 300 random strings; the HTML-to-text conversion matches a Python `html.parser`-based reimplementation on 400 generated values; UTF-8 matches `TextDecoder`/`TextEncoder` on 6,000 random inputs.
- **Checked locally only, not committed (third-party licences):** about 30 more real SnapGene files read without unexpected warnings. All 36 CDSs whose file stores a translation reproduce it exactly from the sequence we extract, including intron-split, 3-segment and reverse multi-segment CDSs, and codon_start 2/3 on both strands.
- **GenBank → SnapGene → record:** all GenBank fixtures plus E. coli U00096.3 (4,641,652 bp, 9,285 features) read back identically, with nothing dropped and no warnings, in about 1 s.

## Deliberate deviations from Biopython
- A range that crosses the origin is one wrapping segment; Biopython splits it into two parts.
- Direction absent, 0 or 3 gives strand 0, as specified; Biopython reads these as +1.
- HTML text is rendered properly (character references decoded, whitespace collapsed, line breaks become spaces). Real SnapGene files contain `&amp;nbsp;` inside HTML, which Biopython leaves as literal text.
- Plain values containing `<…>` are kept; Biopython strips anything that looks like a tag.
- `predef` plus `text` keeps the prefix (`GI:238030067`); real files store database cross-references this way, and Biopython keeps only the number.
- `/translation` loses SnapGene's segment separators (`,`) and the final `*`.
- Repeated `<Q>` elements keep all values; Biopython keeps only the last.
- `readingFrame` 2/3 becomes `/codon_start` when missing. A real SnapGene file confirms that readingFrame equals ±codon_start.
- The feature name is inserted as the first `/label`, so a GenBank export keeps it; Biopython adds `/name` instead.
- The description comes from `Description` (Biopython uses `Comments`). The division comes from Type or SequenceClass; Biopython says `UNC` for every natural sequence.
- Primers become `Primer` objects; Biopython makes `primer_bind` features from stored binding sites.

## Known limitations
- **Unverified in SnapGene:** see above. The writer omits SnapGene's enzyme cache packets, which according to the reverse-engineered sgffp format notes SnapGene rebuilds itself.
- **Sticky-end sign rule:** positive means a 5′ overhang and negative a 3′ overhang. This rule comes from another open-source reader's (PlasmidPop's) survey of the files bundled with SnapGene 8.2. No fixture has sticky ends, so it is tested only on synthetic files and round trips.
- **File types:** only `.dna` files are read. `.prot`, `.rna` and files whose sequence is in the compressed packet give no record and a warning.
- **Not written back:**
  - Primer binding sites (ignored on read).
  - Direction 3 (bidirectional).
  - Fuzzy ends.
  - Reverse colours.
  - References (read as a text summary in extras only).
  - Per-segment colours after the first.
  - SnapGene display attributes.
- **Writer changes on round trip** (all reported as warnings or documented):
  - Qualifiers with the same key are grouped together.
  - Several comments are joined into one.
  - Colourless features get SnapGene's default colour.
  - The record name is not stored; it comes from the file name.
  - LastModified is set to `now`.
- **Segment names** are kept in a non-standard `/parts` qualifier, the convention Biopython uses.
- **Qualifier whitespace:** values are trimmed, and line breaks in single-line values become spaces.
- **Malformed XML:** a malformed XML packet is skipped whole, with a warning.
- **HTML limits:** only HTML 4.01 entity names are decoded (with HTML5 code points), and a `>` inside a quoted HTML attribute is not supported. This keeps parsing linear-time on hostile input.

## Requested changes to shared files
None required. One optional suggestion: a per-feature extras field (or a bidirectional flag) in `types.ts` would let bidirectional direction and SnapGene display attributes survive a round trip.