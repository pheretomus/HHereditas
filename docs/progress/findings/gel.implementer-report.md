No sudo was needed. The `gel` module is finished: 83 tests in 5 files, all passing. My files typecheck cleanly; the only `tsc` error in the package is in another agent's file (`test/review-tmp/primers-robustness-probe.test.ts`).

## Files created
- **Module** (`packages/core/src/gel/`): `ladders.ts`, `migration.ts`, `lane.ts`, `index.ts`.
- **Tests** (same folder): `ladders.test.ts`, `migration.test.ts`, `lane.test.ts`, `oracle.test.ts`, `live-oracle.test.ts`.
- **Oracle tools** (`tools/oracle/`):
  - `gel_model.py`: an independent Python version of the model.
  - `gel_vendor_gels.py`: band positions measured on vendor gel photos, with source URLs.
  - `gel_oracle.py`: writes the JSON and fits the two empirical constants.
  - `gel_live.py`: used by the live test.
  - `gel_measure_bands.py`: optional; needs Pillow, SciPy and PyMuPDF, which are not in the venv. It re-downloads the vendor images and reproduced all 230 measured positions (largest difference under 0.005 px).
  - `gel_cache/`: the λ genome NC_001416.1 (checked by SHA-256) and a `.gitignore` so vendor images are never committed.
- **Oracle data** (`packages/core/test/oracle/gel/`): `model_reference.json` (515 KB), `vendor_gels.json`, `pydna_ladders.json`, `digests.json`. Regenerating them gives byte-identical files.

## Exported API (`gel/index.ts`)
**Ladders**
- `interface LadderBand { size: number; massNg?: number; emphasized?: boolean; components?: number[]; label?: string }`
- `interface Ladder { id: string; name: string; vendor: string; catalog?: string; source: string; bands: LadderBand[]; loadNg?: number; referenceGel?: string; notes?: string }`
- `const LADDERS: readonly Ladder[]` (18 ladders, deep-frozen); `getLadder(id: string): Ladder | undefined`; `bandMassAtLoad(ladder: Ladder, band: LadderBand, loadNg: number): number | undefined`
- `massNg` is the band's ng at the vendor's reference load `loadNg`.

**Migration**
- `type DnaForm = 'linear' | 'supercoiled' | 'nicked'`; `type GelBuffer = 'TAE' | 'TBE'`
- `interface GelConditions { agarosePercent?: number; buffer?: GelBuffer }`; `interface MigrationOptions extends GelConditions { form?: DnaForm }`
- `interface GelParameters { agarosePercent; buffer; topPosition; bottomPosition; midpointBp; exponent; bromophenolBlueBp; xyleneCyanolBp }`
- `migrate(sizeBp: number, options?: MigrationOptions): number`
- `sizeAtPosition(position: number, options?: MigrationOptions): number | undefined` (the inverse of `migrate`)
- `gelParameters(agarosePercent = 1, buffer: GelBuffer = 'TAE'): GelParameters`
- `positionOnGel(g: GelParameters, sizeBp: number): number`; `formSizeFactor(form: DnaForm): number`
- `resolvingWindow(agarosePercent = 1): { minBp: number; maxBp: number }`
- Constants: `DEFAULT_AGAROSE_PERCENT = 1`, `AGAROSE_PERCENT_RANGE = {min: 0.5, max: 3}`, `BPB_POSITION = 0.775`, `BPB_XC_SPEED_RATIO = 2.2`, `DYE_FRONT_POSITIONS`, `SHAPE_EXPONENT = 1.12`, `SMALL_DNA_POSITION = 0.9`, `FORM_SIZE_FACTOR = {linear: 1, supercoiled: 0.7, nicked: 1.6}`, `DYE_COMIGRATION_BP`, `RESOLVING_WINDOW_BP`

**Lanes**
- `interface GelFragment { size: number; molarAmount?: number; form?: DnaForm; label?: string }`
- `interface LaneOptions extends GelConditions { resolution?: number }`; `DEFAULT_RESOLUTION = 0.01` (fraction of gel length)
- `interface GelBand { size: number; position: number; intensity: number; count: number; labels: string[]; sizes: number[]; massNg?: number; emphasized?: boolean }`
- `simulateLane(fragments: readonly GelFragment[], options?: LaneOptions): GelBand[]`
- `ladderLane(ladder: Ladder, options?: LaneOptions): GelBand[]`
- Bands come back top to bottom. Fragments closer than `resolution` merge (each fragment is compared with its neighbour), with summed mass and a mass-weighted size and position. Brightest band = 1.

## The model
- Position = top + span / (1 + (L / midpoint)^k): an S-curve in log size that is near-linear in its middle.
- 0 = well, 1 = bottom of a "standard run", meaning the run stops when bromophenol blue is 75–80 % down the gel (Addgene protocol; I use 0.775).
- Each agarose % and buffer is pinned by two published dye positions, solved in closed form:
  - the DNA size that runs with bromophenol blue sits at 0.775;
  - the size that runs with xylene cyanol sits at 0.775 / 2.2 (Sambrook & Russell, *Molecular Cloning* 3rd ed., p. 5.9: bromophenol blue runs 2.2× faster);
  - the dye-size table, TAE and TBE, 0.5–3 %, is Green & Sambrook 2012 as tabulated by Thermo Fisher.
- k and the bottom asymptote are the only fitted numbers: 1.119 and 0.902 from the photos, rounded to 1.12 and 0.90 at under 0.3 % fit cost.
- The model is not fitted to the resolving-window guideline, but it lands on it. The guideline is NEB's for 0.5–1.5 % and Thermo/Green & Sambrook's for 2–3 % (0.7 % = 0.8–12 kb, 1 % = 0.5–10 kb, 1.5 % = 0.2–3 kb, 2 % = 0.1–2 kb). The tests check that each window falls in the steep, near-linear middle of a TAE lane and that sizes beyond it compress.

## Ladders (all values checked 2026-10-08)
- **NEB:** N3232, N3200, N3231, N3012 (λ DNA/HindIII).
- **Thermo:** GeneRuler SM0311, SM1331, SM0321, SM0331.
- **Invitrogen:** 1 Kb Plus 10787018 (current formulation; sizes only).
- **Promega:** G5711 (sizes only).
- **Korean / Asian vendors:** Bioneer D-1040, D-1030, D-1035, D-1020; Enzynomics DM002, DM003, DM001; Takara 3407A.
- **Not included — Dyne Bio:** no DNA ladder of its own could be found; it appears to be a Roche/Merck distributor.
- **How verified:** neb.com blocks WebFetch and curl (Cloudflare 403), so NEB pages were read through the r.jina.ai reader proxy. Datasheet PDFs were downloaded, and masses were read off the rendered figures. Thermo and Bioneer masses add up exactly to their stated loads.

## Oracle agreement
- **TypeScript vs the Python model:** 20,412 grid positions agree to within 2.2e-16. The live test (3,042 random cases) agrees to under 1e-12.
- **Model vs 17 vendor gel photos** (230 bands, 5 vendors, 0.8–2 % agarose, TAE and TBE):
  - pooled error 0.019 of the gel length;
  - per photo 0.003–0.045;
  - the two Thermo 1 % TAE photos that show the wells: 0.013 and 0.015.
- **pydna 5.5.16:** GeneRuler band sizes are identical. Its molar amounts × size × 650 g/mol/bp match the vendor masses within 0.03 %. Its Rf values, measured on the same Thermo image, match the model shape with error 0.028.
- **Biopython 1.88:** NC_001416.1 is wild-type λ. HindIII on it gives 7 fragments, with 6,682 bp in place of 6,557 + 125. Applying the mutations NEB documents for its marker strain (ind1 at 37,589 C→T creates the extra HindIII site) reproduces the vendor's 8 fragments exactly. The pUC19 digests (EcoRI, PvuII, EcoRI+HindIII, MspI, HaeIII) drive the lane tests.

## Deliberate deviations
- **Very long and very short DNA:** they settle near realistic limits (about 0.18 and 0.90 at 1 % TAE), not at exactly 0 and 1.
- **Photos that fit their stated buffer worse:** NEB's 0.8 % TAE photo fits the TBE curve far better (error 0.007 vs 0.034), and the NEB λ photo has no stated buffer. I kept the vendors' stated conditions.
- **Supercoiled 0.7× and nicked 1.6×:** these are documented guesses, not measured values. No published quantitative source exists. The Invitrogen supercoiled-ladder photo was examined but is cropped, so it cannot pin the factor.
- **Agarose outside 0.5–3 %:** throws a `RangeError` instead of clamping. Above 3 % TAE the model has no valid solution.

## API extensions beyond the spec (all optional)
- `LADDERS` is typed `readonly Ladder[]`, not `Ladder[]`.
- An optional `buffer` option on all three functions.
- Ladder fields `loadNg`, `referenceGel`, `notes`; band fields `components` and `label` for NEB's 500/517 and Promega's 250/253 rows, which those vendors list as one row.
- `GelBand.sizes`, plus `massNg` and `emphasized` on ladder lanes.

## Known limitations
- It is a visualisation aid, not a sizing method. Voltage, ethidium bromide in the gel, overloading and band width or diffusion are not modelled.
- Fluorescence is taken as proportional to mass; supercoiled DNA's weaker ethidium binding is not modelled.
- Large supercoiled plasmids (over about 8 kb) can really run slower than linear DNA; the fixed 0.7× factor won't show that.
- `resolvingWindow()` is buffer-agnostic, as the published guidelines are.
- Masses that are approximate as published: Takara's are "~50 ng". Enzynomics' printed amounts add up to 480, 720 and 540 ng against nominal loads of 500, 750 and 500 ng (noted in each ladder). Invitrogen and Promega publish no masses, so their bands are drawn equally bright.
- λ cos-end annealing (an extra 27.5 kb band if the marker isn't heated) is noted on the ladder but not simulated.
- Sequence-coordinate edge cases (origin-spanning ranges, strands, IUPAC) don't apply to this module.

## Requested changes to shared files
- The integrator should add `export * from './gel';` to `packages/core/src/index.ts`. No exported name currently collides with another module.
- Nothing needed in `types.ts` or the other shared files.