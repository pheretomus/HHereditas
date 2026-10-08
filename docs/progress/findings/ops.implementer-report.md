Files created (all under my ownership; nothing shared was edited, no installs, no git operations, and nothing needed sudo):
- `packages/core/src/ops/`
  - Source: `remap.ts`, `edit.ts`, `transform.ts`, `crud.ts`, `index.ts`, `internal.ts` (validation and copying helpers, not exported)
  - Test-only helper: `test-helpers.ts` (seeded random generator, random records, deep-freeze, invariant checks, per-base model; no Node APIs, not exported)
  - Tests: `remap.test.ts`, `edit.test.ts`, `transform.test.ts`, `crud.test.ts`, `index.test.ts`, `ops.edge.test.ts`, `ops.property.test.ts`, `ops.oracle.test.ts`, `ops.live-oracle.test.ts`, `ops.large.test.ts`
- `tools/oracle/ops_oracle.py`: deterministic generator; regenerating gives byte-identical files.
- `tools/oracle/ops_live.py`: evaluates cases sent by the live test.
- `packages/core/test/oracle/ops/`: `reverse_complement.json`, `rotate.json`, `extract.json`, `concat.json`, `edits.json`, `ligation.json` (largest 1.77 MB).

EXPORTED API (`ops/index.ts`):
- `insertBases(rec: SeqRecord, gap: number, insert: string | SeqRecord): SeqRecord`
- `deleteRange(rec: SeqRecord, range: Range): SeqRecord`
- `replaceRange(rec: SeqRecord, range: Range, replacement: string | SeqRecord): SeqRecord`
- `extractRange(rec: SeqRecord, range: Range, options?: ExtractOptions): SeqRecord`, with `ExtractOptions { name?: string; description?: string }`
- `rotateOrigin(rec: SeqRecord, newOrigin: number): SeqRecord`
- `reverseComplementRecord(rec: SeqRecord): SeqRecord`
- `setTopology(rec: SeqRecord, topology: Topology): SeqRecord`
- `concatRecords(parts: readonly SeqRecord[], options?: ConcatOptions): SeqRecord`, with `ConcatOptions { topology?: Topology; name?: string }`
- `planEdit(edit: SequenceEdit, oldLength: number, topology: Topology): EditPlan`
- `remapFeatures(features: readonly Feature[], edit: SequenceEdit, oldLength: number, topology: Topology): Feature[]`
- `remapRange(range: Range, edit: SequenceEdit, oldLength: number, topology: Topology): Range | null`
- `remapGap(gap: number, edit: SequenceEdit, oldLength: number, topology: Topology, bias?: GapBias): number`
- `addFeature(rec: SeqRecord, feature: Feature): SeqRecord`
- `updateFeature(rec: SeqRecord, id: string, patch: FeaturePatch): SeqRecord`
- `removeFeature(rec: SeqRecord, id: string): SeqRecord`
- `addPrimer(rec: SeqRecord, primer: Primer): SeqRecord`
- `updatePrimer(rec: SeqRecord, id: string, patch: PrimerPatch): SeqRecord`
- `removePrimer(rec: SeqRecord, id: string): SeqRecord`

Types:
- `SequenceEdit = {kind:'insert'; gap: number; length: number} | {kind:'delete'; range: Range} | {kind:'replace'; range: Range; length: number}`
- `EditPlan { oldLength; topology; start; deleted; inserted; wrapsOrigin; insertAt; newLength }`
- `GapBias = 'left' | 'right'`
- `FeaturePatch = Partial<Omit<Feature,'id'>>`, `PrimerPatch = Partial<Omit<Primer,'id'>>`

`planEdit`, `remapRange`, `remapGap` and the `description` option are additions beyond the spec, for UI preview and caret/selection tracking. All functions are pure, and results share no object with their inputs (tested). Invalid gaps or ranges throw a RangeError; a range with end < start is rejected rather than guessed at.

Rules beyond the spec, all documented in TSDoc:
- **Deletion origin:** the original base 0 stays base 0 when it survives; otherwise the first base after the deleted region becomes base 0.
- **Replacing the origin base:** the replacement starts the new sequence. A literal "delete, then insert at gap 0" would append it at the end and rotate the plasmid.
- **Zero-length features (sites):**
  - A site at the left edge of a replaced region ends up before the replacement; one at the right edge ends up after it.
  - At an insertion point, a site stays on the left, per the spec's rule order.
- **Sticky ends under edits:**
  - Deleted single-stranded bases shorten the overhang.
  - Inserted bases join the overhang when they go inside it or at the molecule's outer end, or when they replace only single-stranded bases.
  - Circular results never carry ends.
- **extractRange splitting:** if a circular parent's region holds both ends of a feature but not its middle, the feature is split into separate partial pieces. The first piece keeps the id.
- **concatRecords is a ligation:**
  - Two compatible sticky ends share their overhang bases once; incompatible junctions throw an Error naming the junction.
  - Plain concatenation would duplicate the overhang bases (e.g. `…GAATTAATTC…`) and silently corrupt the sequence.
  - A circular result merges the closing overhangs; a feature longer than the circle is clamped to one turn.
  - Circular parts are opened at their origin; primers are merged without duplicates; colliding feature ids are renamed.
- **Inserted records:** features of an inserted record never reuse an id from the target, even one the same edit removed, so a UI selection id can't silently point at a different feature. The inserted record's primers and ends are not merged.
- **Reverse complement:** partialStart and partialEnd are swapped.

TESTS: 133 tests in 10 files, all passing (7.6 s); ops files typecheck with 0 errors.
- **Hand-written cases** cover every rule on linear and circular records. That includes edit boundaries, insertion at 0 and L, origin-crossing, multi-segment, zero-length and minus-strand features. It also includes deletions across the origin, whole-feature removal, replacement inside a feature, sticky ends, CRUD validation, and empty and 1 bp records.
- **Property tests:** 18 groups × 2,500 seeded random cases (1–300 bp, origin-crossing and multi-segment features, IUPAC bases, sticky ends).
  - Every edit is checked against a per-base model that tracks each base individually, which is stronger than comparing feature sequences.
  - Properties (a)–(f) are all asserted, inputs are deep-frozen, and no output shares an object with its input.
  - To check the tests have teeth, I injected 24 bugs into the implementation. The property suite caught every one, after I added generators that aim at feature and overhang boundaries.
- **Large inputs:** a synthetic 5 Mbp record with 10,000 features and the real E. coli genome. Every operation is exact and finished under the 3 s per-operation cap (the whole file runs in about 2 s).

ORACLE AGREEMENT: 100%, apart from the deliberate deviations below.

| Source | Operation | Cases | Feature comparisons |
|---|---|---|---|
| Stored JSON | reverse complement | 160 | 743 |
| Stored JSON | rotate | 1,048 | 5,287 |
| Stored JSON | extract | 623 | 666 |
| Stored JSON | concat | 300 | 2,667 |
| Stored JSON | edits | 948 | 2,767 |
| Stored JSON | ligation | 250 | 838 |
| **Stored JSON total** | | **3,329** | **12,968** |
| Live oracle | reverse complement | 500 | 1,985 |
| Live oracle | rotate | 500 | 1,801 |
| Live oracle | extract | 477 | 367 |
| Live oracle | concat | 400 | 3,224 |
| Live oracle | edits | 600 | 1,020 |
| Live oracle | ligation | 500 | 3,113 |
| **Live oracle total** | | **2,977** | **11,510** |

The stored oracle uses real fixtures (pUC19, pBR322, NC_005816, pBAD30, an Addgene plasmid, an origin-crossing fuzzy pUC19, KF527485, cor6_6) plus seeded random records. The live oracle uses cases generated in TypeScript at test time and skips cleanly when the Python environment is absent. Ligation includes compatible and incompatible junctions and circularisation. Edits are checked on features outside the edited region; the rest is covered by the per-base model.

DELIBERATE DEVIATIONS FROM THE ORACLES:
1. pydna drops fuzzy `<`/`>` ends when it rotates, slices across the origin or circularises. We keep partial flags; the tests skip that field there and assert our flags are unchanged.
2. Biopython re-sorts features after reverse complement and pydna sorts after rotation. We keep the input order; features are matched by id.
3. Simulating an insertion in Biopython as `rec[:g] + insert + rec[g:]` keeps a site at g twice and moves a feature as one block. Our per-segment rule keeps a zero-length segment at the gap before the inserted bases.
4. When circularising merges overhangs, pydna drops features longer than the circle; we clamp them to one turn.
5. Biopython slicing drops features that span an edit; we trim or extend them (covered by the per-base model).
6. On the oracle side only: pathological random features that cover more than a whole circle make pydna's rotation assert. They are filtered out of the pydna inputs; our implementation handles them.

KNOWN LIMITATIONS:
- **Feature splitting in extraction:** a whole-circle feature whose start lies inside an extracted region is split into two partial pieces (it follows the rule).
- **Clamped circular features:** a multi-segment feature whose segments total more than the circle keeps all its segments after circularisation, possibly covering bases twice.
- **Inserted text is DNA-normalised:** U is converted to T even for RNA records, and raw text into a protein record throws. A DNA record can receive an RNA record, but concatRecords requires identical molecule types.
- **No input validation in two places:** `remapFeatures` and the record operations trust existing feature coordinates to be valid. `remapRange` and the CRUD helpers validate their input.
- **Overhang rules are my own design:** the edit-time sticky-end behaviour has no external oracle, only the per-base model.
- **Full-suite run unfinished:** a full `vitest run` of the whole package did not finish within 10 minutes. One test worker outside ops/ was CPU-bound (likely one of the in-progress files in `test/review-tmp/` or another module). I stopped only my own run, and all ops tests pass when run by path.

REQUESTED CHANGES TO SHARED FILES: none required. Suggestions:
1. Promote the strict range validator (`checkRange` in `ops/internal.ts`) to `seq/range.ts` so other modules reject bad ranges the same way.
2. Note in `types.ts` that an origin-crossing feature may arrive as one wrapping segment or as two segments `[s,L)+[0,e)`; ops handles both.
3. For the integrator: exported names like `remapRange`, `planEdit`, `EditPlan`, `ConcatOptions` and `FeaturePatch` should be checked for collisions with other modules when re-exporting everything from the package root.