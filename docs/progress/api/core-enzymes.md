# @hhereditas/core: `enzymes` module API

This page is for downstream integrators: the UI team, the app shell, the cloning and gel modules.

- **Source:** `packages/core/src/enzymes/` (`data.ts`, `enzyme.ts`, `search.ts`, `digest.ts`, `sets.ts`, `index.ts`).
- **Internal file:** `ends.ts` holds the shared linear end rule. It is not exported.
- **Status:** final verification done on 2026-10-08.
  - 140 tests, all passing. `tsc` reports no errors in `src/enzymes`.
  - Results agree with Biopython 1.88 and pydna 5.5.16, and match two published marker digests. Details are under [Verification evidence](#verification-evidence).

## Importing

- **Inside `packages/core`:** `import { findSites, digest } from '../enzymes';`.
- **From apps and packages:** use `@hhereditas/core`. This works once the integrator adds `export * from './enzymes';` to `packages/core/src/index.ts`.
  - None of the 44 export names collides with the exports of `seq`, `io`, `primers`, `ops`, `gel` or `cloning` (checked 2026-10-08).
- **Shared types used below** come from `types.ts`: `Range`, `Topology`, `EndKind`, `DnaEnd`, `FragmentEnds`, `CutPair`, `EnzymeSite`.

## Conventions

All functions follow the coordinate conventions of `types.ts`.

| Topic | Rule |
|---|---|
| Positions | 0-based. A `Range` is half-open, `[start, end)`. |
| Gap position `p` | The boundary between base `p-1` and base `p`, with `p` in `[0, L]`. Cut sites are gap positions. On circles, positions are taken modulo `L`. |
| Circular ranges | A footprint or fragment that crosses the origin has `end > L`, with `start` in `[0, L)`. |
| Strand | `1` means the recognition sequence reads 5'→3' on the top strand. `-1` means it was found on the bottom strand, as the reverse complement. |
| Sequences | Uppercase IUPAC by convention. The search accepts any case. Digests keep the case of the input. |
| Target ambiguity | Only A, C, G and T in the target can match. An N, R or other ambiguity code in the target never matches, not even under an N of the site. Biopython differs here: its regex accepts any letter under a site N. |
| Lengths | In bases. See the size convention under [Digest](#digest-digestts). |

**Cut offsets (`EnzymeCut`)**
- Gap positions counted from the first base of the recognition site, in top-strand coordinates, for the site read 5'→3' on the top strand.
- Values can be negative, or larger than the site length.
- `top < bottom` gives a 5' overhang, `top > bottom` a 3' overhang, and `top === bottom` a blunt end.

| Enzyme | Site / notation | `cuts` | End |
|---|---|---|---|
| EcoRI | `G^AATTC` | `[{top: 1, bottom: 5}]` | 5' overhang AATT |
| PstI | `CTGCA^G` | `[{top: 5, bottom: 1}]` | 3' overhang TGCA |
| SmaI | `CCC^GGG` | `[{top: 3, bottom: 3}]` | blunt |
| BsaI | `GGTCTC(1/5)` | `[{top: 7, bottom: 11}]` | 4-nt 5' overhang, cuts outside the site |
| BaeI | `(10/15)ACNNNNGTAYC(12/7)` | `[{top: -10, bottom: -15}, {top: 23, bottom: 18}]` | two breaks |

**Site found on the bottom strand.** For a footprint starting at `p` with site length `n`, the cut offsets are mirrored:
- top cut = `p + n - cut.bottom`
- bottom cut = `p + n - cut.top`

A palindromic site is reported once, with strand 1.

**Linear end rule.** `findSites` and `digest` share this rule, so the enzyme map and the digest of a record always agree. A cleavage event can cut a linear molecule only if both of these hold:
- Its cut zone `[min(top, bottom), max(top, bottom)]` lies inside the base-paired part of the molecule, with at least 1 bp to spare on each side.
- Its recognition site is fully double-stranded, not in or across a single-stranded overhang.

With blunt ends (the default) this is Biopython's rule: both cuts must lie in `[1, L-1]`. A cut exactly at gap 0 or `L` cleaves nothing. The site is still listed, with `cuts: []`.

## Catalogue (`enzyme.ts`, `data.ts`)

**Data source**
- REBASE "emboss" release 404, as packaged in Biopython 1.88. Citation: Roberts RJ et al., Nucleic Acids Res. 2023;51:D629.
- The methyl-directed flags come from REBASE bairoch.610, entries typed `R2*`.
- Regenerate with `tools/oracle/.venv/bin/python tools/oracle/enzymes_generate.py`. `data.ts` is a generated file: do not edit it by hand.

**Types**
```ts
interface EnzymeCut { top: number; bottom: number }            // gap offsets from the site's first base (see Conventions)
interface RestrictionEnzyme {
  name: string;                 // REBASE spelling, e.g. 'EcoRI', 'CviKI-1'
  site: string;                 // recognition sequence 5'->3', uppercase IUPAC, e.g. 'GCCNNNNNGGC'
  cuts: ReadonlyArray<EnzymeCut>; // one entry per cleavage event (2 for BaeI/CspCI-type enzymes)
  suppliers: string;            // REBASE supplier codes, e.g. 'BN'; '' if not sold
  commercial: boolean;          // suppliers !== ''
  methylDirected?: boolean;     // true: cuts only METHYLATED sites (DpnI...); absent = false
}
interface Overhang { kind: EndKind; length: number; sequence?: string }
type EnzymeRow = readonly [name: string, site: string, cuts: readonly number[], suppliers: string]; // raw data.ts row
```

**Constants**

| Export | Type | Meaning |
|---|---|---|
| `ENZYMES` | `readonly RestrictionEnzyme[]` | All 754 enzymes with defined cleavage, commercial or not. Sorted case-insensitively by name. The objects are frozen: copy before you modify. Includes the enzymes with 1–2 bp sites (AbaSI `C`, FspEI `CC`), which match almost everywhere, so filter before display. |
| `COMMERCIAL_ENZYMES` | `readonly RestrictionEnzyme[]` | The 623 enzymes with at least one supplier. |
| `COMMON_ENZYME_NAMES` | `readonly string[]` | 48 curated cloning enzymes, roughly in order of popularity. The list starts EcoRI, BamHI, HindIII, XhoI, XbaI, NotI, …, and also includes DpnI, PvuII, PvuI, AflII, BsrGI, SacII, NruI, BlpI and Esp3I. |
| `COMMON_ENZYMES` | `readonly RestrictionEnzyme[]` | `COMMON_ENZYME_NAMES` resolved, in the same order. All 48 are commercial. |
| `SUPPLIERS` | `Readonly<Record<string, string>>` | Supplier code to company name, e.g. `N` → 'New England Biolabs', `B` → 'Thermo Fisher Scientific'. |
| `METHYL_DIRECTED_ENZYMES` | `readonly string[]` | The 24 enzyme names flagged `methylDirected`. 16 of them are commercial. |
| `ENZYME_DATA_SOURCE` | `{ rebaseEmbossRelease: '404'; biopythonVersion: '1.88'; methylDirectedSource: string }` | Release information for an "About" dialog. |

**Functions**

| Signature | Semantics |
|---|---|
| `getEnzyme(name: string): RestrictionEnzyme \| undefined` | Exact name, case-insensitive, trimmed. Accepts Biopython's `_` for REBASE's `-` (`CviKI_1`). |
| `isPalindromic(site: string): boolean` | `site === reverseComplement(site)`, IUPAC-aware and case-insensitive. |
| `overhang(enzyme): Overhang` | The end left by the FIRST cut pair. `length = abs(top - bottom)`. `sequence` is the single-stranded top-strand bases, e.g. EcoRI `'AATT'` or `''` for blunt. It is present only when those bases lie inside the site and are all A/C/G/T. Throws if the enzyme has no cuts. |
| `cutsOutsideSite(enzyme): boolean` | True if any cut is `< 0` or `> site.length` (Type IIS-like). A cut exactly at the site boundary counts as inside. |
| `effectiveSiteLength(site: string): number` | Specificity in "fully specified bases": A/C/G/T count 1, R/Y/… count 0.5, N counts 0. EcoRI = 6, BglI = 6, AvaI = 5. Returns `NaN` for a non-IUPAC site. |
| `cutNotation(enzyme): string` | REBASE-style display text: `'G^AATTC'`, `'GGTCTC(1/5)'`, `'(10/15)ACNNNNGTAYC(12/7)'`. Round-trips for all 754 enzymes. |
| `isoschizomers(enzyme, list = ENZYMES): RestrictionEnzyme[]` | Enzymes that recognise the same sequence, written either as is or as its reverse complement. Excludes `enzyme` itself, matched by name. Keeps list order. |
| `neoschizomers(enzyme, list = ENZYMES)` | Isoschizomers that cut at different positions, e.g. SmaI vs XmaI. |
| `equischizomers(enzyme, list = ENZYMES)` | Isoschizomers that cut at the same positions, e.g. SacI and SstI. |
| `validateEnzyme(enzyme): string[]` | Problems that make an enzyme unusable: empty name or site, non-IUPAC site, no cuts, non-integer offsets, or `abs(offset) > 1000`. An empty list means valid. |
| `makeEnzyme(init: { name: string; site: string; cuts: ReadonlyArray<EnzymeCut>; suppliers?: string; methylDirected?: boolean }): RestrictionEnzyme` | Builds a user-defined enzyme. Upper-cases the site, copies the cuts, and sets `commercial = suppliers !== ''`. Throws an `Error` listing every problem. |

## Site search (`search.ts`)

```ts
interface SiteSearchOptions { ends?: FragmentEnds }  // linear molecules only; default both blunt
function findSites(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[], options?: SiteSearchOptions): EnzymeSite[];
function findSitesForEnzyme(seq: string, topology: Topology, enzyme: RestrictionEnzyme, options?: SiteSearchOptions): EnzymeSite[];
function countCuts(sites: readonly EnzymeSite[]): Map<string, number>;
function countSites(sites: readonly EnzymeSite[]): Map<string, number>;
function compareSites(a: EnzymeSite, b: EnzymeSite): number;
// EnzymeSite (types.ts): { enzyme: string; range: Range; strand: 1 | -1; cuts: CutPair[] }   CutPair: { top: number; bottom: number }
```

**`findSites` returns every occurrence on both strands.**
- **Sort order:** `range.start`, then enzyme name (code-unit order), then strand 1 before −1.
- **`range`:** the footprint. On circles it may wrap the origin (`end > L`).
- **`cuts`, circular molecules:** every event, normalized into `[0, L)` independently for top and bottom.
- **`cuts`, linear molecules:** only the events that can cut by the linear end rule. Values lie in `[1, L-1]`.
- **Sticky-ended linear records:** pass `{ ends: record.ends }`. Otherwise a site inside a single-stranded overhang is shown as cutting, which `digest` refuses. Example: the TCGA overhang of an XhoI end looks like a TaqI site.
- **Ignored inputs:** `options.ends` is ignored for circular molecules and for `''`.
- **Errors:** throws for an invalid enzyme definition, or for ends that are invalid or leave no base pair.
- **Overlapping sites** are all reported.
- **Enzyme identity** is the name: if two entries share a name, only the first is searched.
- **Degenerate non-palindromic sites:** where such a site (MspJI `CNNR`) matches both ways at one position, both orientations are reported.
- **Palindromic sites with asymmetric catalogue cleavage** (SgeI, HauII) carry the cuts of both readings.
- **Short circles:** a circle shorter than a site is not searched for that enzyme.

**Counting and sorting helpers**
- **`countCuts`:** the number of DISTINCT cleavage events `(top, bottom)` per enzyme.
  - Two sites that make the same double-strand break count once.
  - A BaeI site cut on both sides counts 2.
  - A site that cannot be cleaved counts 0.
  - Keys appear in order of first occurrence.
- **`countSites`:** the number of recognition sites per enzyme, both strands.
- **`compareSites`:** the sort order of `findSites`.

## Digest (`digest.ts`)

```ts
interface DigestOptions { ends?: FragmentEnds }      // linear input ends; default blunt; ignored for circles
interface DigestCut { enzyme: string; top: number; bottom: number } // parent gap positions (circular [0, L), linear [1, L-1])
interface DigestFragment {
  seq: string;            // FULL duplex extent, top-strand orientation, overhang bases included; input case kept
  topology: Topology;     // 'linear' for every cut product; 'circular' only for an uncut circle
  ends: FragmentEnds;     // FragmentEnds convention of types.ts (blunt/blunt for an uncut circle)
  parentRange: Range;     // extent of seq in the parent; circular: start in [0, L), may wrap (end > L);
                          // a circle cut once gives a range of L + overhang; sliceRange(parent, parentRange) === seq
  length: number;         // seq.length in bases (overhangs included, see SIZE CONVENTION)
  leftCut?: DigestCut;    // absent at the original left end of a linear parent
  rightCut?: DigestCut;   // absent at the original right end of a linear parent
}
type SkipReason = 'end' | 'conflict' | 'overhang-too-long';
interface SkippedCleavage {
  enzyme: string; site: Range; strand: 1 | -1;
  top: number; bottom: number;           // circular: [0, L); linear: raw, may lie outside [0, L]
  reason: SkipReason; message: string;   // message uses 1-based positions, for display
  blockedBy?: DigestCut;                 // reason 'conflict': the applied break that prevents it
}
interface DigestReport { fragments: DigestFragment[]; skipped: SkippedCleavage[] }
interface DigestSize { size: number; topology: Topology }

function digest(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[], options?: DigestOptions): DigestFragment[];
function digestDetailed(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[], options?: DigestOptions): DigestReport;
function digestSizes(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[], options?: DigestOptions): number[];
function digestSizesWithTopology(seq: string, topology: Topology, enzymes: readonly RestrictionEnzyme[], options?: DigestOptions): DigestSize[];
```

**`digest`**
- **Order:** fragments come in parent order (ascending `parentRange.start`). On a circle, the fragment that spans the origin comes last.
- **Fragment count:**

  | Input | Result |
  |---|---|
  | Circular, `n ≥ 1` applied breaks | `n` linear fragments |
  | Circular, no cut | 1 intact circular molecule |
  | Linear, `n` breaks | `n + 1` fragments; the outermost keep the input ends |
  | `''` | `[]` |
- **Fresh results:** every returned object is new, unfrozen and unshared, so callers may modify results.
- **Errors:** throws for an invalid enzyme, or for ends that are invalid or leave no base pair.

**`digestDetailed`** also returns `skipped`: the cleavage events that were found but not applied.
- **Granularity:** one entry per recognition site and cut pair.
- **Sort order:** top, bottom, enzyme name, site start, strand.
- **Events whose break is made are not listed.** This holds even when another site or enzyme is credited with that break. The exception is reason `'end'`: an event that cannot cut by itself is listed even when another site makes the same break, e.g. a BsaI site straddling a sticky end while the BsmAI site inside it cuts.
- **Reasons:**

  | Reason | Applies to | Meaning |
  |---|---|---|
  | `'end'` | linear | The event breaks the linear end rule. |
  | `'overhang-too-long'` | circular | The event's overhang would be as long as the molecule. Tiny circles only. |
  | `'conflict'` | both | The event's cut zone leaves no base pair between it and an applied break. |

**Model**
- **Identical breaks:** events with the same `(top, bottom)` are one break. It is credited to the enzyme name that sorts first, e.g. BamHI + MboI on GGATCC, or BsaI + BsmAI.
- **Conflicts:** breaks whose cut zones overlap or touch are resolved by a documented greedy rule. Walk 5'→3' along a strand chosen from the molecule itself; apply the first break; skip every later break that conflicts with the last applied one.
  - The result does not depend on the origin of a circle, on which strand the sequence is written on, or on the order of `enzymes`.
  - When a molecule is its own reverse complement around a conflict, both choices give the same physical fragments.
  - A real digest gives a mixture. The `skipped` messages say so.
- **Recognition sites** are taken from the intact molecule.

**Size convention.** Read this before you build a fragments table or a gel lane.
- `DigestFragment.length`, `digestSizes` and `DigestSize.size` are the FULL duplex extent. That counts the single-stranded overhang bases.
  - EcoRI-linearized pUC19 is 2690.
  - pBR322 cut with MspI gives fragments that are each 2 more than the published sizes.
- Marker datasheets, NEBcutter and lab convention give cut-to-cut (top-strand) sizes, which add up to the plasmid length. EcoRI-linearized pUC19 is 2686 there.
- If you need the conventional size:

  ```ts
  const cutToCut = (f: DigestFragment) =>
    f.length - (f.ends.left.kind === '3prime' ? f.ends.left.length : 0) - (f.ends.right.kind === '5prime' ? f.ends.right.length : 0);
  ```

  This formula reproduces the published pBR322/MspI and pUC19/MspI marker sizes exactly. There is a test in `digest.test.ts`.
- On a gel the difference (≤ 9 nt) does not affect migration, but labels shown to users should normally be cut-to-cut sizes.
- Changing the meaning of `length` or `digestSizes` is a spec decision and has not been made. See [Known limitations](#known-limitations).

**Gel helpers**
- **`digestSizes`:** fragment lengths (full extents), largest first.
  - It cannot tell an uncut plasmid from a linear molecule of the same size.
- **`digestSizesWithTopology`:** sizes plus topology, largest first; ties keep parent order. Use this for gel lanes.
  - An entry with `topology: 'circular'` is an uncut plasmid. Map it to the gel's `'supercoiled'` form, and optionally also `'nicked'`.
  - `'linear'` entries are cut products.

## Enzyme sets (`sets.ts`)

```ts
function uniqueCutters(sites: readonly EnzymeSite[]): string[];
function cuttersWithCount(sites: readonly EnzymeSite[], n: number, enzymes?: readonly RestrictionEnzyme[]): string[];
function nonCutters(sites: readonly EnzymeSite[], enzymes: readonly RestrictionEnzyme[]): string[];
interface EnzymeFilter {
  minSiteLength?: number;          // literal site length, N included (BglI = 11)
  minEffectiveLength?: number;     // effectiveSiteLength >= this (6 = "6+ cutters")
  commercialOnly?: boolean;
  suppliers?: string | readonly string[];  // sold by at least one of these codes ('N' or ['B','N']); '' / [] matches nothing
  overhang?: readonly EndKind[];   // kind of the FIRST cut pair's end
  palindromicOnly?: boolean;
  excludeMethylDirected?: boolean;
}
function filterEnzymes(list: readonly RestrictionEnzyme[], filter: EnzymeFilter): RestrictionEnzyme[];
```

**Counting rule.** Counts are distinct cleavage events (`countCuts`), not sites. Results are sorted by name and list each name once.

| Function | Returns |
|---|---|
| `uniqueCutters` | Enzymes with exactly one cleavage event. |
| `cuttersWithCount(sites, n)` | Enzymes with exactly `n` events, taken from the enzymes present in `sites`. |
| `cuttersWithCount(sites, n, enzymes)` | Exactly the enzymes of the list, matched by name. Absent enzymes count 0; enzymes found in `sites` but not in the list are never returned. |
| `nonCutters(sites, enzymes)` | `cuttersWithCount(sites, 0, enzymes)`. |
| `filterEnzymes` | The enzymes of `list` matching every given criterion, in list order. A new array. |

## Recipes

```ts
// Enzyme map of a record (pass the ends for linear records, so the map agrees with digest):
const sites = findSites(rec.seq, rec.topology, enzymes, rec.topology === 'linear' && rec.ends ? { ends: rec.ends } : {});

// Default display set "unique 6+ cutters":
const pool = filterEnzymes(COMMERCIAL_ENZYMES, { minEffectiveLength: 6, excludeMethylDirected: true });
const unique = uniqueCutters(findSites(rec.seq, rec.topology, pool, rec.topology === 'linear' && rec.ends ? { ends: rec.ends } : {})); // names, sorted

// Digest & gel sheet:
const opts = rec.topology === 'linear' && rec.ends ? { ends: rec.ends } : undefined;
const report = digestDetailed(rec.seq, rec.topology, chosen, opts);
// table rows: report.fragments (show cutToCut(f) as "size (bp)", ends, leftCut/rightCut enzyme names)
// warnings:   report.skipped (message is user-readable; reason 'conflict' = ambiguous double digest)
const lane = digestSizesWithTopology(rec.seq, rec.topology, chosen, opts).map((d) => ({ size: d.size, form: d.topology === 'circular' ? 'supercoiled' : 'linear' }));
```

**Measured performance** (Node 22.23, WSL2, 2026-10-08):

| Workload | Time |
|---|---|
| All 754 enzymes on a 10 kb circle | 35 ms |
| All commercial enzymes on pUC19 | 12 ms |
| EcoRI on the 4.6 Mb E. coli genome | 20 ms (search), 20 ms (digest) |
| 48 common enzymes on the genome | 0.43 s (search), 0.49 s (digest) |

Searching the WHOLE catalogue on a genome returns millions of sites, because AbaSI's site is the single base `C`. Filter first, e.g. with `excludeMethylDirected` or `minEffectiveLength`.

## Verification evidence

**Site search vs Biopython 1.88**
- Every enzyme was checked on planted sequences, pUC19, pBR322 and a random 3 kb sequence, linear and circular.
- 100,782 cleavage events are identical.
- On 6 real sequences never used by the oracle, 549,863 more events are identical: a 60 kb E. coli slice, NC_005816, two Addgene plasmids, pBAD30, and SnapGene pFA-KanMX4.
- **Documented deviations:**
  - Ambiguity codes in the target never match.
  - Both orientations are reported for MspJI-like sites.
  - Both readings are used for SgeI and HauII.
  - The TspRI/TscAI `ovhg` field is wrong in Biopython; our data follows fst5/fst3 and NEB.

**Digest vs pydna 5.5.16**
- 547 digests in the static oracle files.
- Live random cases, also on 12 extra seeds, including sticky ends with sites across the single-stranded ends.

**Published markers.** These are reproduced exactly as cut-to-cut sizes:
- pBR322/MspI: Nippon Gene Marker 10, 26 fragments.
- pUC19/MspI and HpaII: Thermo Scientific SM0221 Marker 23, 13 fragments.

**Independent strand-level model** (about 150,000 random digests, about 100,000 of them also with the symmetry checks; 1,500 run in the suite)
- How it works:
  - Cleavage events are enumerated by brute force.
  - Products are rebuilt from single-base strand nodes, with nicks at the cuts and the base pairs inside cut zones melted.
- Checks:
  - Every event is applied, or skipped with the right reason.
  - No event that could cut without a conflict is dropped.
  - Fragments, ends and `parentRange` match the model.
  - `findSites` with the same ends lists exactly the events that can cut.
  - The digest is symmetric under reverse complement, rotation and enzyme order.

**Fixed during verification**
- On circles so small that two cut pairs of one site cut at the same gaps (e.g. TstI on a 32-bp circle), `digestDetailed` used to list that event twice in `skipped`.
- Regression tests are in `digest.test.ts`, in the `verification:` blocks.

## Known limitations

- **Size convention.** `length` and `digestSizes` include overhangs. This is spec-consistent, but differs from the cut-to-cut sizes of datasheets and NEBcutter; use `cutToCut` above for display. Whether to switch the meaning is a decision for the spec owner.
- **No methylation blocking.** Dam, Dcm and CpG blocking is not modelled; the data has no blocking information, so, for example, Dam-blocked XbaI or ClaI sites are cut in the simulation.
- **Methyl-directed enzymes.** These (DpnI, MspJI, …; `methylDirected: true`) are simulated as if every site were methylated, so DpnI "cuts" a PCR product in the simulation. Warn in the UI, or exclude them with `excludeMethylDirected`.
- **Not modelled.** Star activity, partial digests, buffer compatibility, temperature, and enzymes that need two copies of their site.
- **Conflicts.** Overlapping or touching cut zones are resolved by a deterministic rule; a real digest gives a mixture, and every such event is reported as `'conflict'`.
- **Very small circles.** Behaviour is mathematically consistent but has no practical meaning: in cloning work, dsDNA circles shorter than about 100 bp practically never occur.
  - Cut positions are reduced modulo `L`.
  - A circle shorter than a site is not searched for that enzyme.
  - On circles not longer than an enzyme's overhang (≤ 9 bp), `findSites` lists events that `digest` skips as `'overhang-too-long'`.
- **Version skew.** Cleavage data is REBASE 404 (2024). Methyl-directed flags are REBASE 610 (2026).
- **Frozen catalogue.** Catalogue objects are frozen; copy them before you edit.
- **Name identity.** Enzymes are identified by name everywhere; a duplicate name in a list is ignored.
