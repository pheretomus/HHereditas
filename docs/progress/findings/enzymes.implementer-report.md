The enzymes module is finished. All 100 of its tests pass in under a second, and `tsc` reports no errors in any of my files. No sudo was needed at any point.

I created only files in my ownership area, made no git operations, installed no dependencies, and did not touch shared files. Oracle runs left a few `enzymes_*.pyc` files in `tools/oracle/__pycache__`; I deleted them (gitignored anyway). Two `.pyc` files there belong to other agents' scripts.

**FILES CREATED**
- `/home/srdgjuchdr/HHereditas/packages/core/src/enzymes/`
  - `data.ts` — generated, do not edit by hand
  - `enzyme.ts`, `search.ts`, `digest.ts`, `sets.ts`, `index.ts`
  - Tests: `enzyme.test.ts`, `search.test.ts`, `digest.test.ts`, `sets.test.ts`, `oracle.test.ts`, `live-oracle.test.ts`
- `/home/srdgjuchdr/HHereditas/packages/core/test/oracle/enzymes/`
  - `load.ts` — test-only helpers: JSON and fixture loading, a seeded random generator, pydna strand comparison
  - Oracle data: `enzyme_props.json`, `search_planted.json`, `search_puc19.json`, `search_pbr322.json`, `search_random3k.json`, `pydna_digests_single.json`, `pydna_digests_multi.json` (each under 2 MB)
- `/home/srdgjuchdr/HHereditas/tools/oracle/`
  - `enzymes_generate.py` writes `data.ts`
  - `enzymes_oracle.py` writes the JSON
  - `enzymes_common.py` holds the shared reference helpers
  - `enzymes_live.py` is used by the live test
- Regenerating with both generators reproduces byte-identical output (checked).
- Regenerate commands, from the repository root:
  - `tools/oracle/.venv/bin/python tools/oracle/enzymes_generate.py`
  - `tools/oracle/.venv/bin/python tools/oracle/enzymes_oracle.py`

**DATA**
- **Source:** REBASE "emboss" release 404 as packaged in Biopython 1.88 (Roberts RJ et al., Nucleic Acids Res. 2023;51:D629, doi:10.1093/nar/gkac975).
- **What is included:** all 754 enzymes whose cut positions are defined. 623 are commercial. The other 131 are kept with `commercial: false` and an empty supplier string, because they still appear on published maps and in older protocols. The 334 enzymes whose cleavage is unknown are excluded.
- **Cut encoding:** `top = fst5`, `bottom = size + fst3`; two-cut enzymes get a second pair.
- **Naming:** REBASE's `CviKI-1` is used instead of Biopython's `CviKI_1`; `getEnzyme` accepts both.
- **Supplier table:** `SUPPLIERS` maps each code to the company name.
- **Methyl-directed flag:** taken from REBASE's Bairoch format, version 610, where entries typed `R2*` "only recognize the sequence when it is methylated".
  - 24 catalogue enzymes are flagged, 16 of them commercial (e.g. DpnI, MalI, GlaI, MspJI, AbaSI).
  - The list is embedded in the generator so it runs offline; `--bairoch FILE` recomputes it from a newer download.
- **Not imported:** Biopython's `opt_temp`/`inact_temp`, because every enzyme has the placeholder values 37/65.

**EXPORTED API** (re-exported from `enzymes/index.ts`)

All positions follow `types.ts`: 0-based gap positions in top-strand coordinates.

*Data (`data.ts`)*
- `ENZYME_DATA_SOURCE`
- `SUPPLIERS: Readonly<Record<string,string>>`
- `type EnzymeRow = readonly [name, site, cuts: readonly number[], suppliers]`
- `METHYL_DIRECTED_ENZYMES: readonly string[]`

*Model (`enzyme.ts`)*
- `interface EnzymeCut { top: number; bottom: number }`
- `interface RestrictionEnzyme { name; site; cuts: ReadonlyArray<EnzymeCut>; suppliers: string; commercial: boolean; methylDirected?: boolean }`
- `interface Overhang { kind: EndKind; length: number; sequence?: string }`
- `isPalindromic(site: string): boolean`
- `overhang(enzyme): Overhang` — uses the first cut pair; `sequence` is the top-strand bases, given only when they lie inside the site and are all A/C/G/T.
- `cutsOutsideSite(enzyme): boolean` — true when any cut is below 0 or beyond the site length.
- `effectiveSiteLength(site): number` — log4-based specificity, e.g. BglI = 6, AvaI = 5.
- `cutNotation(enzyme): string` — e.g. `'G^AATTC'`, `'GGTCTC(1/5)'`, `'(10/15)ACNNNNGTAYC(12/7)'`.
- `isoschizomers(enzyme, list = ENZYMES): RestrictionEnzyme[]`
- `neoschizomers(enzyme, list = ENZYMES): RestrictionEnzyme[]`
- `equischizomers(enzyme, list = ENZYMES): RestrictionEnzyme[]`
- `validateEnzyme(enzyme): string[]`
- `makeEnzyme(init: { name; site; cuts; suppliers?; methylDirected? }): RestrictionEnzyme` — throws if invalid.
- `getEnzyme(name): RestrictionEnzyme | undefined` — case-insensitive exact name.
- `ENZYMES` (754, frozen), `COMMERCIAL_ENZYMES` (623)
- `COMMON_ENZYME_NAMES` / `COMMON_ENZYMES` (48, ordered): the 40 enzymes you listed plus PvuII, PvuI, AflII, BsrGI, SacII, NruI, BlpI, Esp3I.

*Search (`search.ts`)*
- `findSites(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[]): EnzymeSite[]` — sorted by start, then name, then strand 1 before −1.
- `findSitesForEnzyme(seq, topology, enzyme): EnzymeSite[]`
- `countCuts(sites): Map<string, number>` — distinct (top, bottom) cleavage events; a site that cannot be cleaved counts 0.
- `countSites(sites): Map<string, number>`
- `compareSites(a, b): number`
- Internal only, not in `index.ts`: `compileEnzyme`, `scanEnzymeSites`, `SitePattern`, `CompiledEnzyme`.

*Digest (`digest.ts`)*
- `interface DigestCut { enzyme; top; bottom }`
- `interface DigestFragment { seq; topology; ends: FragmentEnds; parentRange: Range; length; leftCut?: DigestCut; rightCut?: DigestCut }`
- `interface DigestOptions { ends?: FragmentEnds }`
- `type SkipReason = 'end' | 'conflict' | 'overhang-too-long'`
- `interface SkippedCleavage { enzyme; site: Range; strand; top; bottom; reason; message; blockedBy?: DigestCut }`
- `interface DigestReport { fragments; skipped }`
- `digest(seq, topology, enzymes, options?): DigestFragment[]`
- `digestDetailed(seq, topology, enzymes, options?): DigestReport`
- `digestSizes(seq, topology, enzymes, options?): number[]` — largest first.

*Enzyme sets (`sets.ts`)*
- `uniqueCutters(sites): string[]`
- `cuttersWithCount(sites, n, enzymes?): string[]`
- `nonCutters(sites, enzymes): string[]`
- `interface EnzymeFilter { minSiteLength?; minEffectiveLength?; commercialOnly?; suppliers?: string | readonly string[]; overhang?: EndKind[]; palindromicOnly?; excludeMethylDirected? }`
- `filterEnzymes(list, filter): RestrictionEnzyme[]`

**TESTS: 100 passed, 0 failed, about 0.9 s**

| File | Tests |
|---|---|
| `enzyme.test.ts` | 25 |
| `search.test.ts` | 31 |
| `digest.test.ts` | 25 |
| `sets.test.ts` | 9 |
| `oracle.test.ts` | 8 |
| `live-oracle.test.ts` | 2 |

- **Requested hand checks:**
  - pUC19 EcoRI: one site at [283, 289), cut at 284/288, matching the end of the fixture's polylinker annotation 233..289; HindIII opens the polylinker at 232, and the MCS sites come in annotation order.
  - BsaI on both strands, PstI 3′ ends, SmaI vs XmaI.
  - Overlapping sites (HhaI, MnlI, AluI), origin-spanning sites, N/R in the target, lower case.
  - Empty, length-1 and too-short molecules.
- **Property tests (seeded):**
  - The search matches a brute-force reference on 400 random cases (including N, R and lower case) and on fully degenerate custom sites.
  - Rotation invariance on circles, reverse-complement symmetry, and linear results being the circular results that do not cross the origin.
  - 600 random digests × 3 checked for: tiling of the parent, ligatable ends, at least 1 bp of duplex per fragment, `parentRange` slicing back to the fragment, and every cleavage event accounted for. More than 50 conflicts were exercised.
  - Digests are origin-independent on circles and reverse-complement symmetric.
- **Performance** (targets in brackets; the tests use much looser limits):

| Workload | Time | Target |
|---|---|---|
| All 754 enzymes on a 10 kb circle | 26–35 ms | < 100 ms |
| EcoRI on the 4.6 Mb E. coli genome | 18 ms, 646 sites (Biopython also finds 646) | < 300 ms |
| 48 common enzymes on the genome | 0.42 s | < 5 s |

The genome test skips when the file is absent. The live test skips cleanly without the venv (checked); `HH_ORACLE_PYTHON` overrides the interpreter path and `HH_ENZYMES_LIVE_SEED` the seed.

**ORACLE AGREEMENT**
- **Biopython site search, every one of the 754 enzymes:**
  - 10,556 comparisons on planted sequences. These are 5,278 sequences, each run linear and circular, with 7 designs per enzyme. The designs plant sites at both ends, in both orientations and across the origin, plus exact-boundary cases with the outermost cut at gap 1 / L−1 and at gap 0 / L.
  - pUC19, pBR322 and a random 3 kb sequence, linear and circular.
  - 100,782 cleavage events identical in total: 23,496 planted, 20,052 pUC19, 35,419 pBR322, 21,815 random 3 kb. Both top and bottom cuts are compared.
  - Zero disagreements with the corrected expectation. Plain Biopython `search()` differs in 123 comparisons, all caused by the documented Biopython defects listed below and confined to the 10 enzymes they affect.
- **Enzyme properties, all 754:** site, cuts, suppliers, palindromic flag, overhang kind/length/sequence and isoschizomer/neoschizomer/equischizomer lists all identical to Biopython. The one exception is the documented TspRI/TscAI overhang length.
- **pydna `Dseq.cut()`:** 547 digests (single and double digests, Type IIS, 3′ overhang, blunt, degenerate, two-cut, sticky input ends, plasmids). 1,701 fragments identical in watson, crick, ovhg and end kinds/lengths, plus 14 uncut molecules. 15 generated cases with conflicting cut zones were excluded.
- **Live oracle:** default seed gives 500/500 search cases and 218/218 digests identical (32 conflict cases excluded). An exploratory sweep over 25 more seeds gave 12,500 search cases and about 5,600 digests identical, with no failures.

**DELIBERATE DEVIATIONS FROM THE ORACLES**
1. **Ambiguity codes in the target never match**, even under an N of the site. This follows your spec; Biopython's regex `.` accepts any letter there.
2. **Both orientations at one position:** when a degenerate non-palindromic site matches both ways at the same spot (MspJI, LpnPI, plus 4 non-commercial enzymes), both occurrences are reported. Biopython's regex alternation reports only one.
3. **Palindromic sites with asymmetric cleavage (SgeI, HauII):** the cuts of both readings are applied, since both orientations are recognised. Biopython applies only the forward reading.
4. **TspRI/TscAI:** the overhang comes from fst5/fst3 (9 nt, `NNCASTGNN`, which matches NEB). Biopython's `ovhg` field says 10, which shifts its linear end filter by one.
5. **Palindromic two-cut enzymes on circles:** Biopython's `_drop` assumes sorted results, which these are not. The oracle sorts first; this was never triggered in the data.
6. **Circles shorter than the recognition site** are not searched for that enzyme.
7. **Linear ends:** Biopython's rule is adopted — an event is kept only if both cuts lie in [1, L−1]; a cut exactly at gap 0 or L is dropped, and the site stays listed.
8. **Digest vs pydna:**
   - Conflicting cut zones (zones that overlap or touch, leaving no base pair between them) are resolved by a documented rule. Walking 5′→3′, the first event in position order is applied and later conflicting events are skipped and reported. On circles the walk starts at a point no cut zone covers, so the result does not depend on the origin.
     - pydna instead raises `ValueError` or returns unpaired fragments.
   - Identical double-strand breaks from different enzymes are applied once; pydna yields an empty fragment or raises.
   - With no cuts, the intact molecule is returned; pydna returns an empty tuple.
   - With sticky input ends, a cut zone must leave at least 1 bp before the single-stranded end, and the recognition site must be fully double-stranded. pydna's own site check is wrong for bottom-strand sites, so those cases are kept away from the ends in comparisons.

**KNOWN LIMITATIONS**
- **No methylation blocking:** Dam, Dcm and CpG blocking of sites is not modelled, because the data has no such information. Only the methyl-directed flag exists, and digests treat methyl-directed enzymes as if every site were methylated.
- **Not modelled:** star activity, partial digests, buffer compatibility and temperatures.
- **The conflict rule is an approximation:** in a real digest the outcome depends on which enzyme acts first.
  - A cut inside another enzyme's recognition sequence does not stop that enzyme unless their cut zones conflict.
  - If conflicting zones cover an entire circle, the walk starts at the origin, so the result then depends on where the origin is.
- **Fragment lengths include single-stranded overhangs.** For example, EcoRI-linearised pUC19 is 2,690. For a circle cut once, `parentRange` is longer than L, but `sliceRange(parent, parentRange) === seq` always holds.
- **Very small circles:** cut positions are reduced modulo L.
- **Version skew:** cleavage data is REBASE 404 (2024); the methyl-directed list is REBASE 610 (2026).
- **Full catalogue on genomes:** five methyl-directed enzymes have 1–2 bp sites. Searching a genome with the whole catalogue returns millions of sites, so the UI should filter, e.g. with `excludeMethylDirected`.

**REQUESTED CHANGES TO SHARED FILES**
None are required. Suggestions:
- **`src/index.ts` (integrator):** add `export * from './enzymes'`. I checked for name collisions with the sibling modules that exist so far and found none.
- **`types.ts` docs:**
  - Note that `DigestFragment.parentRange` for a circle cut once is L + overhang long.
  - Note that linear `CutPair` values from the search lie in [1, L−1].
- **Spec extension:** `RestrictionEnzyme` gained one optional field, `methylDirected`.
- **Additions beyond the spec:**
  - `COMMERCIAL_ENZYMES`, `COMMON_ENZYME_NAMES`, `ENZYME_DATA_SOURCE`, `METHYL_DIRECTED_ENZYMES`
  - `cutNotation`, `effectiveSiteLength`, `equischizomers`, `makeEnzyme`, `validateEnzyme`
  - `compareSites`, `countSites`, `digestDetailed`, `nonCutters`
  - `EnzymeFilter` options `minEffectiveLength` and `excludeMethylDirected`