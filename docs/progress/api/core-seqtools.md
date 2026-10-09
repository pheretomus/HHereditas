# @hhereditas/core: seqtools API (genetic codes, translation, ORFs, search, sequence statistics)

Source: `packages/core/src/seq/{codon-tables,translate,orf,search,stats}.ts`, re-exported by
`packages/core/src/seq/index.ts` and therefore by the package root (`import { translate } from '@hhereditas/core'`).
Status: final verification 2026-10-08. 279 module tests are green, and the module has no tsc errors.
See "Verification evidence" at the end.

## 0. Conventions that apply to every function

- **Coordinates** follow `types.ts`: 0-based, half-open `[start, end)`, always in **top-strand** coordinates.
  On circular molecules a range that crosses the origin has `end > L` (normalized: `0 <= start < L`,
  `end - start <= L`). Use `sliceRange` / `splitAtOrigin` from `seq/range.ts` to read or draw such ranges.
- **Strand**: `1` means the hit/ORF reads 5'->3' on the top strand, `-1` on the bottom strand (the reverse complement).
- **Frame** (`Orf.frame`, `ProteinSearchHit.frame`): `0 | 1 | 2`. For strand 1 it is `range.start % 3`, counted
  from the start of the sequence. For strand -1 it is counted from the END of the sequence: the position of the
  first codon base in the reverse complement, mod 3 (`(L - range.end) % 3` when the range does not wrap).
- **Input alphabet**: nucleotide inputs are case-insensitive, read U as T, and accept the IUPAC codes
  `ACGTRYSWKMBDHVN`. Protein inputs accept ASCII letters, case-insensitive (only a-z are folded, so 'ß' or 'ı' are
  rejected, not turned into residues). Error messages name the offending character and its 0-based UTF-16 index.
- **Pure**: no function mutates its arguments; all results are new objects.
- **Errors**: `TranslationError` (a subclass of `Error`, `name === 'TranslationError'`) is thrown for bad
  *sequence / feature data* (a non-IUPAC base in a translated codon, a malformed qualifier, a bad segment).
  `RangeError` is thrown for bad *caller options* (unknown table id, frame, maxMismatches, ...) and for invalid
  characters in a search query, peptide or the statistics inputs. The table in §6 lists what each function throws.
- **Units**: masses in Da (= g/mol), pI and pH in pH units, extinction coefficients in M^-1 cm^-1 at 280 nm,
  GC content as a fraction 0..1 (multiply by 100 for %).

## 1. Genetic codes (`seq/codon-tables.ts`, generated from Biopython 1.88, checked against NCBI gc.prt 4.6)

```ts
interface GeneticCode {
  readonly id: number;                 // NCBI /transl_table id (1 standard, 11 bacterial, 2 vertebrate mito, ...)
  readonly name: string;               // NCBI name, e.g. 'Bacterial, Archaeal and Plant Plastid'
  readonly names: readonly string[];   // all Biopython names + NCBI's current name where it was renamed (24)
  readonly forwardTable: Readonly<Record<string, string>>; // codon (DNA, 'TTT') -> one-letter amino acid; stop-only codons absent
  readonly startCodons: readonly string[]; // NCBI order
  readonly stopCodons: readonly string[];  // NCBI order; in tables 27/28/31 some are ALSO in forwardTable (context-dependent stops)
  readonly ncbieaa: string;            // 64 amino acids in NCBI codon order, '*' = never translated
}
const GENETIC_CODES: readonly GeneticCode[];     // ids 1-6, 9-16, 21-33 (27 tables), sorted, deeply frozen
const NCBI_CODON_ORDER: readonly string[];       // the 64 codons TTT, TTC, TTA, TTG, TCT ... GGG
function getGeneticCode(id = 1): GeneticCode;    // throws RangeError for unknown ids (7, 8, 17-20 are unassigned)
```
UI: populate a "genetic code" picker from `GENETIC_CODES` (`id` + `name`).

## 2. Translation (`seq/translate.ts`)

```ts
class TranslationError extends Error {}

interface TranslateOptions {
  table?: number;          // NCBI table id, default 1
  frame?: 0 | 1 | 2;       // leading bases skipped before the first codon, default 0
  toStop?: boolean;        // stop before the first stop codon ('*' not included), default false
  cds?: boolean;           // treat the input (after `frame`) as a complete CDS, default false
}
function translate(dna: string, options?: TranslateOptions): string;
```
- Returns one letter per **complete** codon read from index `frame`. A trailing partial codon is ignored, and
  `'*'` marks stop codons. `translate(s, {frame}).length === Math.max(0, Math.floor((s.length - frame) / 3))`
  (or less with `toStop`).
- Ambiguous codons are translated exactly as in Biopython: one amino acid when all expansions agree (`GCN` -> `A`),
  `B` (D/N), `Z` (E/Q), `J` (I/L), `'*'` when every expansion is a stop (`TAR`), and otherwise `X` (`TAN`, `NNN`).
- `cds: true`: the first codon is read as an initiator, giving `M` when it is a start codon of the table
  (`GTGAAATAA`, table 11 -> `MK*`, without cds -> `VK*`). An ambiguous initiator that mixes start and non-start
  codons gives `X` (GTN in table 11). The last codon of an input that is a whole number of codons is `'*'` when it
  is a stop codon of the table; this matters only for the context-dependent stops of tables 27, 28 and 31. Unlike
  Biopython, it never throws for an "invalid CDS" and it keeps the final `'*'`.
- Tables 27/28/31: their context-dependent stop codons are read as amino acids inside the sequence. `toStop`
  without `cds` throws `TranslationError` for these tables, because where translation stops is undefined.
- Characters outside the translated codons (skipped frame bases, the partial tail) are not inspected.

```ts
interface TranslateFeatureOptions {
  table?: number;          // used only when the feature has no /transl_table (the qualifier wins); default 1
  toStop?: boolean;        // default false
  cds?: boolean;           // default: feature.type === 'CDS'
  translExcept?: boolean;  // apply /transl_except, default true
}
function translateFeature(rec: SeqRecord, feature: Feature, options?: TranslateFeatureOptions): string;
```
- Builds the feature's own 5'->3' sequence: segments joined in array order, with origin-wrapping segments allowed
  on circular records. Strand -1 is reverse-complemented, and strand 0 is read as +1. It then applies
  `/codon_start` (1, 2 or 3), `/transl_table` and `/transl_except` (e.g. `(pos:220..222,aa:Sec)`, or
  `aa:TERM` for a stop codon completed by polyadenylation; join/complement locations are accepted).
- With coding rules (`cds`, the default for CDS features) the result equals NCBI's GenBank `/translation`,
  **plus a final `'*'`** when the CDS ends with a stop codon. Strip one trailing `'*'` to compare with `/translation`.
  - The initiator rule (M for any start codon of the table) applies only when the feature is **5'-complete**
    (`/codon_start=1` and no fuzzy 5' end), as in NCBI's translator. The 5' end is `partialStart` for strand 1/0
    and **`partialEnd` for strand -1** (`partialStart`/`partialEnd` refer to the low/high top-strand coordinate).
  - **A trailing partial codon (1-2 bases) can add one residue**: it is padded with N and kept unless it is
    `X`, as NCBI does (`...GC` -> `A`, `...CT` -> `L`; `...GA` and single bases add nothing). So the result can be
    one residue longer than the number of complete codons. A UI that aligns residues under codons must expect the
    last residue to span only 1-2 bases.
  - A 3'-partial CDS does not turn a context-dependent stop into `'*'`.
- With `cds: false`, the feature is translated literally: no initiator rule and no partial-codon residue
  (`/transl_except` still applies unless disabled).
- Every `TranslationError` message names the feature (`feature.name`), so a caller translating all CDSs can
  report the bad one and keep going. Causes are: a protein record; a segment that is not a valid range of the
  record; a non-IUPAC base; a missing, unparsable or conflicting `/codon_start` or `/transl_table`; a
  `/transl_table` that is not an NCBI code; and a `/transl_except` that cannot be applied (for example a remote
  location). An unknown `options.table` is a `RangeError` instead, because it is caller input, not feature data.

## 3. ORFs (`seq/orf.ts`)

```ts
interface FindOrfsOptions {
  minAaLength?: number;                  // keep ORFs with aaLength >= this (stop excluded); default 100
  table?: number;                        // genetic code for start/stop codons; default 1
  startCodons?: 'ATG' | 'table';         // default 'ATG'; 'table' = every start codon of the table
  strands?: 'both' | 'top' | 'bottom';   // default 'both'
  includeNested?: boolean;               // default false: only the longest ORF per stop codon
  allowNoStop?: boolean;                 // default false: also report frames without a stop (hasStop: false)
}
function findOrfs(seq: string, topology: Topology, options?: FindOrfsOptions): Orf[];
// Orf (types.ts): { range: Range; strand: 1 | -1; frame: 0 | 1 | 2; aaLength: number; hasStop: boolean }
```
- `range` runs from the first base of the start codon to the last base of the stop codon, inclusive, in
  top-strand coordinates. On circular molecules ORFs may cross the origin (`range.end > L`) and never cover more
  than one full turn. When `L % 3 != 0`, reading continues across the origin in the shifted frame.
- A codon is a stop only when every IUPAC expansion is a stop of the table (`TAR` yes, `TAN`/`NNN` no; context
  stops of 27/28/31 count). An ambiguous start counts only when every expansion is a start.
- `allowNoStop`: on a linear molecule the ORF runs to the last complete codon, keeping the longest per strand and
  frame. On a circular molecule it covers one full turn (`floor(L/3)` codons), keeping one per strand and
  reading-frame cycle: the one whose start comes first. `includeNested` keeps all of them.
- Sorted by `range.start`, then `range.end`, then strand (1 first). `aaLength` excludes the stop codon.

## 4. Search (`seq/search.ts`)

```ts
interface SearchOptions {
  strands?: 'both' | 'top' | 'bottom';   // default 'both'
  maxMismatches?: number;                // integer 0..3, default 0; substitutions only (no indels)
  iupac?: boolean;                       // default true
}
function searchSequence(seq: string, topology: Topology, query: string, options?: SearchOptions): SearchHit[];
// SearchHit (types.ts): { range: Range; strand: 1 | -1; mismatches: number }
```
- A hit is a window of the top strand, `range.end - range.start === query.length`, and it may wrap the origin on
  circular molecules. Strand -1 means the window equals the reverse complement of the query.
- `iupac: true`: a query code matches every base it stands for (query N matches anything). An ambiguous
  **sequence** base matches only a query code that covers all its bases, so sequence N matches only query N.
  `iupac: false` requires identical letters. Non-IUPAC sequence characters never match and count as mismatches.
- A query that is its own reverse complement (GAATTC, GANTC) is reported once per window, as strand 1, when both
  strands are searched. Overlapping hits are all reported, sorted by start, then strand (1 first).
- An empty query, or one longer than the sequence, gives `[]`.
- **There is no hit cap.** A degenerate query (e.g. 20 × N) on a genome returns millions of hits, so the UI should
  cap or warn before rendering.

```ts
interface ProteinSearchOptions {
  table?: number;          // genetic code, default 1
  nTerminal?: boolean;     // default false; see below
}
interface ProteinSearchHit extends SearchHit { frame: 0 | 1 | 2 } // mismatches is always 0
function searchProtein(seq: string, topology: Topology, peptide: string, options?: ProteinSearchOptions): ProteinSearchHit[];
```
- This is a six-frame translated search. `range` covers the coding bases (3 × peptide length) in top-strand
  coordinates and may wrap the origin. Hits are sorted by start, then strand (1 first), then end.
- Codons are read exactly as `translate` reads them. Peptide letters: the 20 amino acids; `B` = D/N, `Z` = E/Q,
  `J` = I/L (each also matches the translated ambiguity letter itself); `X` = any amino acid but not a stop;
  `'*'` = a stop codon of the table, including context stops (TGA in table 27 matches both W and `*`);
  `U` (Sec) = the codon TGA and `O` (Pyl) = the codon TAG, whatever the table says.
- **`nTerminal: true`** makes the first letter also match its codon read as an initiator, so an N-terminal `M`
  matches GTG/TTG/ATT/... starts. Without it, the N-terminal peptide of the ~10% of bacterial genes that start
  with a non-ATG codon is NOT found. Turn it on for a "find this protein / N-terminal peptide" feature.

## 5. Composition and physico-chemical properties (`seq/stats.ts`; formulas and constants of Biopython 1.88)

```ts
function gcContent(seq: string): number;
function baseCounts(seq: string): Record<string, number>;
interface DnaMolecularWeightOptions {
  doubleStranded?: boolean;        // add the complementary strand, default false
  circular?: boolean;              // no ends: one more phosphodiester bond per strand, default false
  molecule?: 'DNA' | 'RNA';        // default 'DNA'; with 'RNA', T is read as U
  monoisotopic?: boolean;          // default false (average masses)
  fivePrimePhosphate?: boolean;    // default true (Biopython); false = 5'-OH ends (synthetic oligos), -79.98 Da per linear strand
}
function dnaMolecularWeight(seq: string, options?: DnaMolecularWeightOptions): number;
function proteinMolecularWeight(protein: string): number;
function proteinChargeAtPh(protein: string, pH: number): number;
interface IsoelectricPointOptions { interval?: 'biopython' | 'unbounded' }   // default 'biopython'
function proteinIsoelectricPoint(protein: string, options?: IsoelectricPointOptions): number;
function proteinExtinctionCoefficient(protein: string): { reduced: number; oxidized: number };
```
- `gcContent`: (G + C + S) / (G + C + S + A + T + U + W). All other codes (N, R, Y, ...) and characters are left
  out of both numerator and denominator, so `'ACGTNNNN'` gives 0.5. Returns 0 when nothing is countable. This
  equals Biopython `gc_fraction(seq, ambiguous="remove")`. (The primers module's `oligoGcContent` instead weights
  ambiguity codes, which is a different quantity.)
- `baseCounts`: counts per character, with ASCII lower case counted as upper case. Keys A, C, G and T are always
  present; any other character appears only when it occurs. **Key order**: digits first (a JavaScript object
  rule), then A, C, G, T, then the others by code unit (`'acgtN1'` gives `['1','A','C','G','T','N']`). Sort the
  entries yourself if you need another order.
- `dnaMolecularWeight`: each strand is the sum of its nucleoside monophosphates minus one water per bond (a
  5'-phosphate and a 3'-OH, as in Biopython). `'AA'` weighs 644.43 Da, or 564.45 Da with `fivePrimePhosphate: false`.
  The empty sequence weighs 0. Throws `RangeError` on N and the other ambiguity codes, whose mass is undefined.
- `proteinMolecularWeight`: average masses, sum of residues minus waters. One trailing `'*'` is ignored, and the
  empty protein weighs 0. Accepts the 20 amino acids plus U and O; throws on B/Z/J/X and on an internal `*`.
- `proteinChargeAtPh`: Henderson-Hasselbalch net charge with the Bjellqvist pK set (Biopython `charge_at_pH`).
  B/Z/J/X/U/O are treated as uncharged. Returns NaN for an empty protein.
- **`proteinIsoelectricPoint`: the default reproduces Biopython bit for bit**, including its flaw: Biopython only
  searches pH [4.05, 12] and returns the bound when the true pI lies outside. The FLAG tag DYKDDDDK gives **4.0500**
  by default, although its pI is **3.9714** (`{ interval: 'unbounded' }`). By ExPASy's figures, very acidic
  proteins such as prothymosin-α and very basic ones such as protamine are likewise clamped. A default result
  within 1e-4 of 4.05 or 12 means "at or beyond this bound". **UI: pass `{ interval: 'unbounded' }` when
  displaying pI.** It is identical to the default whenever the pI lies inside (4.05, 12) and is within 5e-5 of the
  true root everywhere. The unbounded value is not clamped to pH 0-14: 200 × Arg gives 14.30, where ExPASy would
  report 14.00. ExPASy also differs when the C-terminal residue is D or E (ExPASy uses pK 3.55 there; E10:
  ExPASy 3.29, this model 3.47). An empty protein gives NaN.
- `proteinExtinctionCoefficient`: Pace et al. 1995 values. `reduced = 5500·W + 1490·Y`, and
  `oxidized = reduced + 125·floor(C/2)` (all Cys in cystines), equal to Biopython and ExPASy ProtParam. For the
  absorbance of a 1 mg/mL solution, divide by `proteinMolecularWeight`.

## 6. What throws what

| Function | TranslationError | RangeError |
|---|---|---|
| `getGeneticCode` | – | unknown id |
| `translate` | non-IUPAC char in a translated codon; `toStop` with table 27/28/31 without `cds` | unknown/non-integer table; frame not 0-2 |
| `translateFeature` | protein record; bad segment; non-IUPAC base; bad `/codon_start`, `/transl_table`, `/transl_except` (message names the feature) | unknown `options.table` |
| `findOrfs` | non-IUPAC char in `seq` | unknown table; invalid options |
| `searchSequence` | – (non-IUPAC sequence chars just never match) | non-IUPAC query char; `maxMismatches` not an integer 0-3; bad `strands` |
| `searchProtein` | non-IUPAC char in `seq` | invalid peptide char (`-`, `.`, digits, non-ASCII); unknown table; non-boolean `nTerminal` |
| `gcContent`, `baseCounts` | – | – (never throw) |
| `dnaMolecularWeight` | – | any char other than ACGT (DNA) / ACGUT (RNA), incl. N |
| `proteinMolecularWeight` | – | B/Z/J/X, internal `*`, non-letters |
| `proteinChargeAtPh`, `proteinIsoelectricPoint`, `proteinExtinctionCoefficient` | – | non-letters, internal `*`; pI: bad `interval` |

## 7. Recipes for integrators

- **Six-frame display**: `translate(seq, { frame, table })` for frames 0-2. For the bottom strand use
  `translate(reverseComplement(seq), { frame, table })`; residue i of the bottom-strand frame f covers
  reverse-complement bases `f + 3i .. f + 3i + 2`, i.e. top-strand `[L - f - 3i - 3, L - f - 3i)`. On circular
  molecules, translate across the origin by rotating, or by translating `seq + seq.slice(0, 2)`.
- **Translate a selection** (top-strand range `r`): `translate(sliceRange(seq, r))`; for the reverse strand,
  `translate(reverseComplement(sliceRange(seq, r)))`. Use `cds: true` only when the selection starts at a real
  start codon.
- **CDS translations in the sequence view**: call `translateFeature(rec, feature)` (it gives the NCBI-exact
  result, honouring `/transl_except`, partial ends, wrapping segments and the trailing partial codon) and drop a
  final `'*'` if you do not show stops. Catch `TranslationError` per feature and show it as "untranslatable:
  message". The viewer's placeholder `translateFeatureLite` (packages/viewer, UI team) decides "5'-complete"
  from `!feature.partialStart` for every strand. That is wrong for strand -1, whose 5' end is `partialEnd`, so
  replace it with the core function.
- **ORF map**: `findOrfs(seq, topology, { minAaLength: 100 })`. ORFs crossing the origin have `range.end > L`;
  draw them with `splitAtOrigin`.
- **Find/search box**: `searchSequence` for DNA motifs and primers (`maxMismatches` ≤ 3), and `searchProtein`
  for peptides (`nTerminal: true` for an N-terminal peptide). Both return top-strand ranges that may wrap.
- **Protein properties panel**: `proteinMolecularWeight`, `proteinIsoelectricPoint(p, { interval: 'unbounded' })`,
  `proteinExtinctionCoefficient`, `proteinChargeAtPh(p, 7)`. Strip or keep one trailing `'*'`, since both work.
  Reject or explain X/B/Z/J before computing the molecular weight.

## 8. Known limitations and deliberate deviations

- pI default = Biopython's clamped bisection (spec: "equal to Biopython within 0.01"); see §5. Making
  `'unbounded'` the default needs a spec change.
- `searchProtein` without `nTerminal` misses alternative-start N-termini (spec: plain six-frame search).
- No hit cap in `searchSequence`/`searchProtein`. `findOrfs` with `includeNested`, table-11 start codons and
  `minAaLength: 30` returns 499,438 ORFs on E. coli (0.24 s).
- Search is substitution-only (no gaps). Ambiguous sequence bases need a covering query code.
- ORFs can run through N-runs, because `TAN`/`NNN` are not stops.
- `translate` and the stats functions reject `X`, `-`, digits and whitespace in nucleotide input (Biopython is
  inconsistent with X). Biopython's `molecular_weight` silently strips whitespace; ours throws.
- Differences from Biopython, all documented in TSDoc:
  - `cds` translation never throws and keeps the final `'*'`.
  - 5'-partial CDSs keep their first amino acid (the NCBI rule).
  - `/transl_except` is applied (Biopython ignores it).
  - Empty DNA or protein weighs 0 (Biopython: 18.0153).
  - pI of an empty protein is NaN (Biopython raises).
  - One trailing `'*'` is ignored by the protein functions.
- Differences from NCBI's start-residue consensus: ATR in table 21 gives M (NCBI: X), and 20 context-stop codons in
  tables 27/28/31 give their amino acid (NCBI: X). A non-TERM `/transl_except` on an X-padded partial last codon
  is still appended, whereas NCBI appends only TERM there.
- A `/transl_except` whose codon covers the overlapping base of a programmed-frameshift join (e.g.
  `join(1..100,100..200)`) is rejected as "not contiguous". No real record with this was seen.
- Selenocysteine and pyrrolysine are uncharged in the pI model, as in Biopython.

## 9. Requests to other owners

- **`seq/range.ts` `sliceRange` (shared file, not seqtools)** loops forever when the sequence is empty and
  `r.end > 0` (`remaining -= 0`). It also reads whole extra turns for ranges with `start >= L`.
  `translateFeature` validates its segments first and is safe, but other callers of `featureSequence` /
  `sliceRange` (UI, ops, cloning) are exposed. Suggested fix in range.ts: `if (L === 0) return ''` plus
  range validation.
- **packages/viewer `translate-lite.ts`**: the 5'-partial test should use `partialEnd` for strand -1 (see §7), or
  be replaced by injecting `translateFeature`.

## Verification evidence (final verifier, 2026-10-08)

- Module suite: `npx vitest run src/seq/{translate,codon-tables,orf,search,stats}.test.ts` gives 279/279 green, with
  the E. coli and live-oracle tests run, not skipped. tsc reports no errors in seqtools files.
- `translateFeature` vs NCBI `/translation`: 4,300 E. coli CDSs (live test) and 18 + 4 committed records all
  match. A one-off check of 1,035 CDSs from 69 fresh NCBI records also matched, every one. Those records covered
  14 genetic codes (1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 22, 28, 33): mitochondrial genomes, *M. genitalium*,
  phage T4 with introns and the gene 60 bypass, HTLV-1 and MoMLV frameshifts and readthrough, Sec ×12, Pyl,
  minus-strand TERM completions, and 25 partial-cds mRNAs.
- Independent TypeScript brute forces, now permanent tests:
  - findOrfs: 4,000 short codon-soup molecules over all 27 tables and every option combination (a one-off run of
    30,000 cases included 12,231 ORFs crossing the origin).
  - searchSequence: 2,000 cases.
  - searchProtein: 1,000 cases with U/O/*/BZJX and nTerminal.
  - `/transl_except` mapping: 2,500 cases with origin wraps, codons split by a junction, and TERM tails.
- Fresh Biopython values (1,500 proteins, 1,200 DNA/RNA): the default pI is bit-identical; `unbounded` is within
  3.2e-5 of a high-precision root; charge agrees to 3e-14 and DNA/RNA weight to 2.4e-7 Da; protein weight, GC
  content and extinction agree exactly.
- Performance on E. coli (4.6 Mb, circular), all well under the spec targets:

  | Operation | Time |
  |---|---|
  | `findOrfs` with defaults | 67 ms |
  | Exact 20-mer search | 57 ms |
  | 2-mismatch 20-mer search | 84 ms |
  | 3-mismatch 20-mer search | 123 ms |
  | GAATTC search | 37 ms |
  | `searchProtein`, 8-mer | 59 ms |
  | Six-frame translation | 356 ms |
  | `gcContent` | 21 ms |
