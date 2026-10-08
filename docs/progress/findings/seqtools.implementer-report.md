The seqtools module is finished and verified. All 217 tests pass in about 1.1 s, my files typecheck cleanly (the whole package now has zero tsc errors), and the full package suite (22 files, 656 tests at last full run) passes with my barrel exports added. The E. coli tests and live-oracle tests ran here because the fixture and venv are present. Nothing was committed, and no sudo was needed.

**FILES CREATED** (all under /home/srdgjuchdr/HHereditas)
- packages/core/src/seq/codon-tables.ts — generated, do not edit
- packages/core/src/seq/translate.ts, orf.ts, search.ts, stats.ts
- packages/core/src/seq/codon-tables.test.ts, translate.test.ts, orf.test.ts, search.test.ts, stats.test.ts
- packages/core/test/oracle/seqtools/oracle.ts — test helpers
- packages/core/test/oracle/seqtools/{tables,codons,translate,features,stats,orfs,search}.json — 1.9 MB total, every file under 0.5 MB
- packages/core/test/oracle/seqtools/ncbi_gc.prt — verbatim copy of NCBI's gc.prt v4.6, downloaded 2026-10-08
- tools/oracle/seqtools_codons.py — generates codon-tables.ts
- tools/oracle/seqtools_oracle.py — writes all the JSON; deterministic, byte-identical on re-run
- tools/oracle/seqtools_live_cds.py — live oracle for the E. coli genome

**FILE MODIFIED:** packages/core/src/seq/index.ts — 18 lines appended. They are named exports, so the internal helpers (marked `@internal`) stay out of the public API.

**EXPORTED API**
- `interface GeneticCode { id; name; names; forwardTable: Readonly<Record<string,string>>; startCodons; stopCodons; ncbieaa }`
- `GENETIC_CODES: readonly GeneticCode[]` — tables 1–6, 9–16, 21–33, frozen
- `NCBI_CODON_ORDER: readonly string[]`
- `getGeneticCode(id = 1): GeneticCode` — throws RangeError for unknown ids
- `class TranslationError extends Error`
- `translate(dna: string, options?: TranslateOptions): string` with `TranslateOptions { table?: number; frame?: 0|1|2; toStop?: boolean; cds?: boolean }`
- `translateFeature(rec: SeqRecord, feature: Feature, options?: TranslateFeatureOptions): string` with `TranslateFeatureOptions { table?; toStop?; cds?; translExcept? }`
- `findOrfs(seq: string, topology: Topology, options?: FindOrfsOptions): Orf[]` with `FindOrfsOptions { minAaLength? (default 100); table?; startCodons?: 'ATG'|'table' (default 'ATG'); strands?: 'both'|'top'|'bottom'; includeNested?; allowNoStop? }`
- `searchSequence(seq: string, topology: Topology, query: string, options?: SearchOptions): SearchHit[]` with `SearchOptions { strands?; maxMismatches? (integer 0..3); iupac? (default true) }`
- `searchProtein(seq: string, topology: Topology, peptide: string, options?: ProteinSearchOptions): ProteinSearchHit[]` with `ProteinSearchOptions { table? }` and `ProteinSearchHit extends SearchHit { frame: 0|1|2 }`
- `gcContent(seq: string): number`
- `baseCounts(seq: string): Record<string, number>`
- `dnaMolecularWeight(seq: string, options?: DnaMolecularWeightOptions): number` with `DnaMolecularWeightOptions { doubleStranded?; circular?; molecule?: 'DNA'|'RNA'; monoisotopic?; fivePrimePhosphate? }`
- `proteinMolecularWeight(protein: string): number`
- `proteinIsoelectricPoint(protein: string): number`
- `proteinExtinctionCoefficient(protein: string): { reduced: number; oxidized: number }`
- `proteinChargeAtPh(protein: string, pH: number): number`

Three things go beyond the spec: `proteinChargeAtPh`, the `fivePrimePhosphate` option, and `/transl_except` support in `translateFeature`.

**TESTS:** 217 passed, 0 failed (codon-tables 64, translate 78, orf 25, search 30, stats 20).

**ORACLE AGREEMENT**
- **Codon tables:** all 27 tables match Biopython exactly. They also match NCBI's own gc.prt for amino acids, starts and stops.
- **Ambiguous codons:** all 3,375 IUPAC codons in all 27 tables (91,125 cases) give the same amino acid and the same start/stop status as Biopython.
- **Random translation:** 1,134 cases (every table, all 3 frames, with and without toStop) and 162 valid CDSs with `cds=true`: all identical to Biopython.
- **GenBank CDS features:** 62 CDSs across 17 records match NCBI's `/translation` and Biopython's own feature translation. These include joins, origin-wrapping CDSs, codon_start 2 and partial ends.
- **E. coli genome (live):** all 4,300 translated CDSs match NCBI's `/translation`, including the 3 selenocysteine `/transl_except` cases and programmed frameshifts with overlapping segments.
- **ORFs:** 400 committed cases match the brute-force reference exactly, plus 6,000 extra one-off fuzz cases.
- **Search:** 300 DNA and 150 protein search cases match the brute-force references, plus 8,000 extra fuzz cases.
- **Stats:**

| Quantity | Biopython function | Cases | Max difference |
|---|---|---|---|
| GC fraction | `gc_fraction(ambiguous="remove")` | 300 | < 1e-12 |
| DNA/RNA weight | `molecular_weight` | 400 | < 1e-6 Da |
| Protein weight | `ProteinAnalysis.molecular_weight()` | 400 | < 1e-6 Da |
| pI | `isoelectric_point()` | 400 + 60 | < 1e-9 |
| Charge at pH | `charge_at_pH` | 2,400 | < 1e-9 |
| Extinction coefficient | `molar_extinction_coefficient()` | 460 | exact |

**PERFORMANCE** (E. coli U00096.3, 4.6 Mb)

| Operation | Target | Measured |
|---|---|---|
| `findOrfs`, default options | < 2 s | 57 ms |
| Exact search, 20-mer | < 300 ms | 47 ms |
| Exact `GAATTC` / `GGNCC` searches | < 300 ms each | 58 ms for both |
| 2-mismatch search, 20-mer | < 3 s | 84 ms |
| Six-frame translation, both strands | — | 226 ms |

**DELIBERATE DEVIATIONS FROM BIOPYTHON** (all documented in TSDoc)
1. **`cds` mode in `translate`** never throws and keeps the final `*`. Biopython raises on an invalid CDS and drops the stop. In tables 27, 28 and 31 the last codon of a complete CDS is read as `*`.
2. **toStop with tables 27, 28, 31** throws `TranslationError`, like Biopython, but only when `cds` is not set. With `cds` the stop position is well defined.
3. **X and other non-IUPAC characters** make translation throw. Biopython inconsistently accepts X: `GCX` gives A, and `XXX` gives X in tables 27/28/31 but raises elsewhere. The project alphabet excludes X.
4. **5'-partial CDSs** (codon_start ≠ 1, or a fuzzy 5' end) do not get M for an alternative start codon. This follows NCBI's own translator (`check_start = is_5prime_complete && frame == 0` in the NCBI C++ Toolkit); Biopython has no such rule.
5. **`/transl_except`** is applied by `translateFeature`; Biopython ignores it. It throws on values it cannot apply (for example a reference to another record). `translExcept: false` turns it off.
6. **Empty input:** the empty DNA or protein weighs 0 (Biopython returns one water, 18.0153). pI of an empty protein is NaN (Biopython raises).
7. **Trailing stop:** one trailing `*` is ignored by the protein functions. Biopython raises for molecular weight and uses `*` as the C-terminus for pI.
8. **RNA:** `dnaMolecularWeight` with `molecule: 'RNA'` accepts T as U.

**KNOWN LIMITATIONS**
- **N-runs:** a codon is a stop only if every expansion is a stop, so TAN and NNN are not stops. An ORF can therefore run through a stretch of Ns.
- **Pathological searches:** no hit cap. A query like 20×N returns millions of hits.
- **Degenerate circular frames:** frames with no stop within one turn are reported only with `allowNoStop`. Without `includeNested`, one is kept per strand and frame cycle, and the choice among equal-length ones is a deterministic convention.
- **Search model:** substitutions only (no gaps). Ambiguous sequence bases match only a query code that covers them (`iupacMatches` semantics).
- **Remote `/transl_except`** locations (pointing at another record) cannot be applied.
- **Selenocysteine and pyrrolysine** are treated as uncharged in pI/charge, as Biopython does.

**REQUESTED CHANGES TO SHARED FILES**
- None to the shared model files.
- **Name collision for the integrator:** `primers/tm.ts` (another agent) exports a different `gcContent`, which uses weighted IUPAC counting and throws on invalid characters. If src/index.ts does `export * from './primers'` alongside `./seq`, TypeScript will report a conflict (TS2308). One of the two needs renaming or an explicit export; mine is the spec'd name.
- **Table 24 name:** Biopython 1.88 calls it "Pterobranchia Mitochondrial". NCBI's current gc.prt (v4.6) renamed it "Rhabdopleuridae Mitochondrial", so I added the new name as an alias in `names`.