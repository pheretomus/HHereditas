# @hhereditas/core: `cloning` module API

- **Source:** `packages/core/src/cloning/` (`result.ts`, `pcr.ts`, `digest-record.ts`, `ligation.ts`, `restriction-cloning.ts`, `gibson.ts`, `golden-gate.ts`, `calculators.ts`, `index.ts`). `test-helpers.ts` is for tests only and is not exported.
- **Import:** `import { pcr, restrictionClone } from '@hhereditas/core'` (the root index re-exports `./cloning`; no export name collisions, tsc clean on 2026-10-09).
- **Status:** implemented 2026-10-09. 56 tests pass, and the results agree with pydna 5.5.16 on 216 differential cases.

## Conventions

- Coordinates follow `types.ts`: 0-based, half-open, top-strand coordinates. Circular ranges that cross the origin have `end > L`. Gap positions are used for junctions and cuts.
- Sticky ends follow the `FragmentEnds` convention:
  - `seq` is the full duplex extent, so overhang bases are included and written as top-strand letters.
  - Two ends are compatible when they have the same kind, the same length and identical overhang text.
- **Size convention:** digest fragments include their overhangs. EcoRI-linearized pUC19 is 2690 bases long, while cut-to-cut it is 2686 bp. Use the `cutToCut` formula from `core-enzymes.md` for display.
- All functions are pure and return new objects.

## Common result shape

```ts
interface CloningOutcome {
  product?: SeqRecord;      // = products[0]
  products: SeqRecord[];    // [] on failure
  warnings: string[];       // human-readable, non-fatal
  error?: string;           // set exactly when there is no product
}
```

The simulations never throw for user-level problems (no binding, incompatible ends, missing overlap, unknown enzyme name). Only programming errors throw, such as an invalid enzyme definition or invalid `rec.ends`. Each result type extends `CloningOutcome` with fields of its own.

## PCR (`pcr.ts`)

```ts
pcr(template: SeqRecord, forward: Primer, reverse: Primer, options?: PcrOptions): PcrResult
type PcrOptions = BindingOptions & { name?: string; maxProducts?: number /* 50 */ }
interface PcrResult extends CloningOutcome { amplicons: PcrAmplicon[] }  // same order as products
interface PcrAmplicon { forwardSite; reverseSite: PrimerBindingSite; templateRange: Range; length: number }
```

**Product sequence.** The product's top strand is the full forward primer (5' tail included), then `template[fe, rs)`, then `reverseComplement(full reverse primer)`.
- Inside the annealed regions, the product carries the primer's bases.
- If the two annealed regions overlap, the overlap is written once.

**Site pairing.** Binding sites come from `findBindingSites` (`minAnneal` defaults to 15).
- On a linear template, a reverse site must lie downstream of the forward site.
- On a circular template, the walk to the reverse site can cross the origin, and `templateRange.end` may be greater than `L`.
- Both primers are searched in both orientations, as happens in a real reaction (and in pydna):
  - Swapped primers still give a product, with a warning.
  - A single primer acting at both ends also gives a product, with a warning.

**Several products.** All of them are returned, sorted by size (smallest first), up to `maxProducts`. A warning is added, and names get the suffix ` (n bp)`.

**Errors** say what went wrong:
- a primer does not bind;
- neither primer binds;
- the primers bind but no sites face each other (wrong orientation, or a linear template with the reverse site upstream);
- an invalid primer;
- an empty template.

**Product record.** The product is linear and blunt.
- Template features inside the amplicon are clipped, and partial flags are set on the clipped ones.
- Two `primer_bind` features cover the full primers, tails included.
- The product's `primers` are the two primers.
- Its name is `<template> PCR` unless `options.name` is given.

## Digest of a record (`digest-record.ts`)

```ts
digestRecord(rec: SeqRecord, enzymes: readonly RestrictionEnzyme[]): DigestedRecord[]
type DigestedRecord = SeqRecord & { parentRange: Range; leftCut?: DigestCut; rightCut?: DigestCut }
```

- The digest model is `enzymes/digest`, and fragments come in parent order.
- For linear records, `rec.ends` is honoured: outer fragments keep their ends, and sites inside overhangs are not cut.
- `ends` is always set on cut fragments.
- Features are clipped as by `ops/extractRange`, which sets partial flags, updates `/codon_start` and drops `/translation`.
- **A circle cut once** gives one fragment of `L + overhang` bases.
  - A feature that crosses the cut is split into a partial piece at each end.
  - A feature that lies in the overhang appears at both ends.
- **When nothing cuts**, the result is a copy of the record. For a circle, `parentRange` is `{0, L}`.
- **Names** have the form `<parent> <leftEnzyme>–<rightEnzyme>`. At an original end of a linear parent, `start` or `end` takes the enzyme's place.

## Ligation (`ligation.ts`)

```ts
endsCompatible(left: SeqRecord, right: SeqRecord): boolean   // right end of `left` vs left end of `right`
ligate(parts: readonly SeqRecord[], options?: { circularize?: boolean; name?: string }): LigationResult
interface LigationResult extends CloningOutcome { junctions: LigationJunction[] }
interface LigationJunction { leftPart; rightPart: number; range: Range; kind: 'blunt'|'5prime'|'3prime'; overhang: string }
```

**`endsCompatible`**
- Blunt + blunt is compatible.
- Two sticky ends must have the same kind, the same length and the same text. Case is ignored.
- Circular records are never compatible.
- BamHI and BglII ends are compatible, since both are `GATC`.

**`ligate`**
- Joins the parts in the given order, using `ops/concatRecords`. A shared overhang is written once.
- The closing overhang of a circle is placed at the start of the product.
- `junctions[].range` is the shared overhang in product coordinates. A blunt junction gives a zero-length range.
- Errors: a circular input, an empty list, or incompatible ends. The error message names the junction and both ends.

## Restriction cloning (`restriction-cloning.ts`)

```ts
restrictionClone({ vector, insert, vectorEnzymes, insertEnzymes?, vectorFragment?: 'largest'|number,
                   insertFragment?: 'auto'|number, orientation?: 'both'|'forward'|'reverse' }): CloningResult
interface CloningResult extends CloningOutcome {
  vectorFragment?: DigestedRecord; insertFragment?: DigestedRecord;
  details: Array<{ orientation: 'forward'|'reverse'; junctions: CloningJunction[] }>; // per product
}
interface CloningJunction extends LigationJunction { enzymes: string[]; recutBy: string[] }
```

**Choosing the fragments**
- **Vector:** the largest fragment by full length, with ties going to the first in parent order. Alternatively, pass an index.
- **Insert, with `'auto'`:**
  - Only fragments whose two ends fit both vector ends, in at least one orientation, are considered.
  - Fragments cut at both ends are preferred, then the longest one, then the first in parent order.
- Products are circular, and the forward orientation comes first.
- When the vector fragment contains the vector's origin, the product keeps the vector's numbering.

**Warnings**
- The vector ends fit each other, so the vector can self-ligate. This applies to single-enzyme and blunt cloning.
- The cloning is non-directional.
- A junction is not recut by either enzyme that made it. This covers BamHI/BglII hybrid sites and blunt mixes. Recutting is checked exactly: a cleavage event must fall on the junction's overhang edges.
- The insert is cut more than twice, because internal sites fragment it.
- A vector enzyme cuts more than once.
- An insert enzyme does not cut the insert.

**Errors**
- an unknown enzyme;
- an enzyme that does not cut the vector;
- no fitting insert fragment;
- the requested orientation is impossible;
- a fragment index is out of range.

## Gibson assembly (`gibson.ts`)

```ts
gibsonAssembly(fragments, { minOverlap?: 15, maxOverlap?: Infinity, circular?: true, name? }): AssemblyResult
interface AssemblyResult extends CloningOutcome { junctions: AssemblyJunction[] }
interface AssemblyJunction { leftFragment; rightFragment; overlapLength; overlapSeq; tm /* °C */; gc /* 0..1 */; range: Range }
terminalOverlap(a, b, max?): number          // longest suffix(a) == prefix(b), KMP
GIBSON_OVERLAP_TM_RANGE = { min: 48, max: 65 }
```

**Junction rule**
- For fragments i and i+1, the longest k in `[minOverlap, maxOverlap]` is used such that the last k bases of fragment i equal the first k bases of fragment i+1.
- A circular assembly also closes the last fragment onto the first.
- Fragments are used as given, in the given order and orientation.
- Each overlap appears once in the product, which starts with fragment 0.
- Sticky ends are ignored, because the exonuclease chews back the 5' ends. A warning says so.
- Junction Tm is computed with `primers/tm` under its default primer3 conditions.

**Errors**
- a missing overlap (the message names the junction);
- an overlap that is too short (the message gives the length found);
- a circular or empty fragment;
- a fragment that lies entirely inside an overlap.

**Warnings**
- An overlap Tm is outside 48–65 °C.
- An overlap sequence occurs elsewhere, on either strand.
- Two junctions have the same overlap.
- The end of a fragment also overlaps a fragment that is not its neighbour, so an alternative order is possible.
- A fragment is shorter than its two overlaps together.

```ts
designGibsonPrimers({ vector /* circular */, insertion: Range, inserts, overlapLength?: 20,
                      annealTargetTm?: 60, amplifyVector?: true }): GibsonDesign
interface GibsonDesign extends CloningOutcome { primers: Primer[]; fragments: SeqRecord[]; junctions: AssemblyJunction[] }
```

**Expected product.** The vector before the insertion, then the inserts in order, then the vector after the insertion.
- The product is numbered like the vector.
- If the insertion range crosses the origin, the first vector base that is kept becomes base 0.

**Primers.** Each primer is an overlap tail followed by an annealing part.
- The annealing part is the shortest stretch of 18–60 bp whose Tm reaches the target.
- At the junction from piece X to piece Y, the overlap is the last ⌈o/2⌉ bases of X followed by the first ⌊o/2⌋ bases of Y.
- With `amplifyVector: false`, the vector backbone is used as it is, and the inserts' primers carry the whole vector overlaps.
- `primers` lists the forward and then the reverse primer of each amplified fragment. The vector comes first when it is amplified.

**Built-in self-check.**
1. Every fragment is made by `pcr()` with the designed primers.
2. The fragments are joined by `gibsonAssembly()`.
3. The assembly is compared with the expected product. If they differ, the result has an error.

The tests repeat this check independently, including on 25 random designs.

**Errors**
- a linear vector;
- an invalid insertion range;
- no inserts;
- a piece shorter than 18 bp;
- a PCR that does not give the expected product.

## Golden Gate (`golden-gate.ts`)

```ts
goldenGate(parts, { enzyme?: 'BsaI', circular?: true, name? }): GoldenGateResult
interface GoldenGateResult extends AssemblyResult { fragments: DigestedRecord[]; order: Array<{ part: number; orientation: 'forward'|'reverse' }> }
```

**Fragment per part.** Each part contributes exactly one fragment: the one cut at both ends that carries no recognition site of the enzyme on either strand. Both circular donor plasmids and linear PCR products work.

**Overhang checks**
- A palindromic overhang is an error.
- An overhang text found on more than two ends is an error, because it duplicates a junction.

**Order.** The order is found from overhang compatibility, by an exhaustive search over at most 30 parts.
- Either orientation of each part may be used.
- Part 0 is always used forward.
- Several possible orders give a warning. No possible order gives an error that lists the unmatched overhangs.

**Junctions** report the 4-nt overhang. Their `tm` is `NaN`.

**A product that still contains a site** gets a warning, because the enzyme would recut it.

## Calculators (`calculators.ts`)

**Mass convention**
- dsDNA uses 650 g/mol per bp, the value in NEB's NEBuilder protocol (`DS_DNA_DALTONS_PER_BP`).
- ssDNA uses 330 g/mol per nt (`SS_DNA_DALTONS_PER_NT`).
- Mass is in ng, amounts in pmol, volume in µl, and concentration in ng/µl.

```ts
dnaPmol(ng, lengthBp, doubleStranded = true)   // ng*1000/(len*650)
dnaNg(pmol, lengthBp, doubleStranded = true)
insertAmountForRatio({ vectorNg, vectorLengthBp, insertLengthBp, molarRatio })  // vectorNg*(ins/vec)*ratio
assemblyAmounts({ vector, inserts, vectorNg?, insertRatio?, maxDnaVolumeUl?: 10 }): AssemblyAmounts
  // rows {name, role, lengthBp, ratio, pmol, ng, volumeUl?}, totalPmol, totalVolumeUl, recommendedTotalPmol, warnings
```

**`assemblyAmounts` defaults** follow the NEBuilder protocol:

| Case | Vector amount | Insert:vector ratio | Recommended total |
|---|---|---|---|
| 1–2 inserts | 50 ng | 2 | 0.03–0.2 pmol |
| 3 or more inserts | 0.05 pmol | 1 | 0.2–0.5 pmol |
| Any insert shorter than 200 bp | | 5 | |

**Checks against published values**
- 50 ng of 5 kb DNA is 0.015 pmol, and 50 ng of 500 bp is 0.15 pmol (NEB).
- For the NEB ligation example, a 3:1 ratio with a 1 kb insert and 50 ng of a 3 kb vector needs 50 ng of insert.

**Invalid numbers** throw a `RangeError`, because these are programming inputs rather than user-level cloning problems.

## Verification

All checks below were run with pydna 5.5.16. The script is `tools/oracle/cloning_oracle.py` (seed 20261009), and it writes `test/oracle/cloning/*.json`.

| Area | Reference | Result |
|---|---|---|
| PCR | 150 cases on pUC19, pBR322 and random templates, linear and circular, with tails and origin-spanning amplicons. pydna `Anneal(limit=15)`. 137 cases have a product and 13 have none (reversed primers). | All agree. |
| Restriction cloning | 26 cases. pydna `Dseqrecord.cut`, then `+`, then `.looped()`. Covers directional pairs, single enzymes, BamHI/BglII, SalI/XhoI and inserts written in reverse. Both orientations are compared up to rotation and reverse complement. | All agree. |
| Gibson | 30 cases. pydna `Assembly(limit=minOverlap)`, circular and linear. | All agree. |
| Golden Gate | 10 cases with BsaI, 3–6 parts, shuffled input order, some parts reversed. | All agree. |

- **Textbook checks:**
  - EcoRI–BamHI cloning into the pUC19 MCS: the product length is the large vector fragment plus the insert, and both sites are regenerated.
  - BamHI/BglII: the hybrid site is reported as not recut.
  - Gibson of 3 PCR inserts designed by `designGibsonPrimers`.
  - Golden Gate of 3 parts with BsaI.
- **Bug found by the oracle and fixed:** a circular PCR where the forward primer's annealing part spans the origin. There is a regression test.
- **One case skipped:** pydna refused one pBR322 BamHI/SalI digest ("internally split"), so it is not in the data.

## Limitations

- `designGibsonPrimers` handles circular vectors only. Inserts shorter than 18 bp must go into primer tails by hand.
- No primer-quality checks (hairpins, dimers) are run on the designed primers. Use `primers/analyzePrimer`.
- Gibson works on the top strand exactly as given: it does not try reverse-complemented fragments. Golden Gate does try both orientations.
- Restriction cloning does not model dephosphorylation, methylation blocking, partial digests or concatemers.
- PCR does not model polymerase errors or limits on product length.
- Golden Gate searches at most 30 parts and needs exactly one site-free fragment per part.
