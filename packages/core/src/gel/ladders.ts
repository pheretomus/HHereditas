/**
 * Commercial DNA size ladders (molecular-weight markers) for agarose gels.
 *
 * EVERY band size and mass below was transcribed from the vendor's own product page or datasheet
 * (URL in `source`, checked 2026-10-08). Nothing is interpolated or guessed: when a vendor does not
 * publish per-band masses the masses are left out, and when a vendor lists two co-migrating
 * fragments as one row of its table (NEB's "500/517"), the row is kept as one band whose
 * `components` lists the fragment sizes. Units: sizes in base pairs (bp) of double-stranded DNA,
 * masses in ng of DNA in the band when `loadNg` ng of ladder, the vendor's recommended load per lane,
 * is loaded (masses that a vendor tabulates for another volume are rescaled to that load).
 */

/**
 * One band of a DNA ladder. Read-only: the built-in ladders are shared, deeply frozen constants (copy
 * them, e.g. `[...ladder.bands]`, before sorting or editing).
 */
export interface LadderBand {
  /** Fragment length in bp, as published by the vendor. For a multi-fragment row see `components`. */
  readonly size: number;
  /** DNA mass (ng) in this band when the vendor's recommended amount (`Ladder.loadNg`) is loaded. */
  readonly massNg?: number;
  /** Reference band that the vendor makes (and prints) brighter for orientation. */
  readonly emphasized?: boolean;
  /**
   * Sizes (bp, largest first) of fragments that the vendor lists together as ONE band because they
   * co-migrate (e.g. NEB's 500/517 bp doublet). `size` is then the vendor's nominal size of the band
   * and `massNg` the combined mass (taken as shared equally by the fragments when drawing a lane).
   */
  readonly components?: readonly number[];
  /** Vendor's label for the band when it is not simply the size, e.g. '500/517'. */
  readonly label?: string;
}

/**
 * A DNA ladder: the bands it contains and where the data comes from. Read-only like
 * {@link LadderBand}; immutable (`as const`) custom ladders are accepted wherever a Ladder is.
 */
export interface Ladder {
  /** Stable identifier, e.g. 'neb-1kb'. Unique within {@link LADDERS}. */
  readonly id: string;
  /** Product name as used by the vendor. */
  readonly name: string;
  /** Company selling the ladder. */
  readonly vendor: string;
  /** Catalogue number of the smallest pack size. */
  readonly catalog?: string;
  /** URL of the product page or datasheet the band sizes and masses were verified against. */
  readonly source: string;
  /** Bands, largest first (strictly decreasing `size`). */
  readonly bands: readonly LadderBand[];
  /**
   * The vendor's recommended load: total DNA (ng) per lane that the `massNg` values refer to. When a
   * vendor tabulates its band masses for a different volume, they are rescaled to this load (see the
   * ladder's comments).
   */
  readonly loadNg?: number;
  /** Gel shown in the vendor's reference image, e.g. '0.8% TAE agarose'. */
  readonly referenceGel?: string;
  /** Caveats copied from the vendor documentation (doublets, cohesive ends, recommended gels). */
  readonly notes?: string;
}

const NEB_N3232 = 'https://www.neb.com/en-us/products/n3232-1-kb-dna-ladder';
const NEB_N3200 = 'https://www.neb.com/en-us/products/n3200-1-kb-plus-dna-ladder';
const NEB_N3231 = 'https://www.neb.com/en-us/products/n3231-100-bp-dna-ladder';
const NEB_N3012 = 'https://www.neb.com/en-us/products/n3012-dna-hindiii-digest';
const TF_SM0311 = 'https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013004_GeneRuler_1kb_DNALadder_250ug_UG.pdf';
const TF_SM1331 =
  'https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013047_GeneRuler_1kb_Plus_DNALadder_250ug_UG.pdf';
const TF_SM0321 =
  'https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013008_GeneRuler_100bp_Plus_DNALadder_50ug_UG.pdf';
const TF_SM0331 = 'https://assets.thermofisher.com/TFS-Assets/LSG/manuals/MAN0013012_GeneRuler_DNALadder_250ug_UG.pdf';
const INV_10787018 = 'https://assets.thermofisher.com/TFS-Assets/LSG/manuals/1Kb_Plus_DNA_ladder_man.pdf';
const PROMEGA_G5711 = 'https://www.promega.com/products/cloning-and-dna-markers/dna-ladder-rna-ladder/1kb-dna-ladder/';
const PROMEGA_WP111 =
  'https://www.promega.com/-/media/files/resources/white-papers/quality-and-stability-of-dna-ladders-shipped-at-ambient-temperature.pdf';
const BIONEER_PM338 = 'https://www.bioneer.co.kr/literatures/manual/LaddersandMarkers/PM-338-En_DNA_ladder.pdf';
const ENZYNOMICS_DM001 = 'https://www.enzynomics.com/shop/product_item.php?it_id=c01003';
const ENZYNOMICS_DM002 = 'https://www.enzynomics.com/shop/product_item.php?it_id=c01004';
const ENZYNOMICS_DM003 = 'https://www.enzynomics.com/shop/product_item.php?it_id=c01005';
const TAKARA_3407A =
  'https://www.takarabio.com/products/cloning/agarose-gel-electrophoresis/dna-and-rna-markers/dna-molecular-weight-markers';

/** Compact band notation: [size bp, mass ng?, emphasized?]. */
type BandRow = readonly [number, number?, boolean?];

function bands(rows: readonly BandRow[]): LadderBand[] {
  return rows.map(([size, massNg, emphasized]) => ({
    size,
    ...(massNg !== undefined ? { massNg } : {}),
    ...(emphasized ? { emphasized: true } : {}),
  }));
}

/**
 * Rescale band masses that a vendor prints for `tableUl` µl of ladder to its recommended load of
 * `loadUl` µl (`massNg * loadUl / tableUl`: the product is exact for the printed values, so the result
 * is the correctly rounded decimal, e.g. 88.5 ng x 2/5 = 35.4 ng).
 */
function atRecommendedLoad(rows: readonly BandRow[], loadUl: number, tableUl: number): BandRow[] {
  return rows.map(([size, massNg, emphasized]) => [size, massNg === undefined ? undefined : (massNg * loadUl) / tableUl, emphasized]);
}

const E = true; // emphasized (reference) band

const LADDER_DATA: Ladder[] = [
  // ---------------------------------------------------------------- New England Biolabs
  {
    id: 'neb-1kb',
    name: '1 kb DNA Ladder',
    vendor: 'New England Biolabs',
    catalog: 'N3232S',
    source: NEB_N3232,
    // Product page "Properties & Usage" table (fragments 10a/10b = 517 and 500 bp, 21 ng each).
    bands: bands([[10002, 42], [8001, 42], [6001, 50], [5001, 42], [4001, 33], [3001, 125, E], [2000, 48],
      [1500, 36], [1000, 42], [517, 21], [500, 21]]),
    loadNg: 500, // "Mass values are for 0.5 µg/gel lane"; "We recommend loading 0.5 µg"
    referenceGel: '0.8% TAE agarose, ethidium bromide',
    notes: 'The 517 and 500 bp fragments co-migrate on agarose. Recommended 0.8-1.2% agarose (optimum 1%).',
  },
  {
    id: 'neb-1kb-plus',
    name: '1 kb Plus DNA Ladder',
    vendor: 'New England Biolabs',
    catalog: 'N3200S',
    source: NEB_N3200,
    bands: [
      ...bands([[10002, 40], [8001, 40], [6001, 48], [5001, 40], [4001, 32], [3001, 120, E], [2017, 40], [1517, 57],
        [1200, 45], [1000, 122, E], [900, 34], [800, 31], [700, 27], [600, 23]]),
      { size: 500, massNg: 124, emphasized: true, components: [517, 500], label: '500/517' },
      ...bands([[400, 49], [300, 37], [200, 32], [100, 61]]),
    ],
    loadNg: 1000, // "Mass values are for 1 µg/lane"; NEB recommends loading 0.5-1 µg
    referenceGel: '1.0% TBE agarose, ethidium bromide',
    notes: 'NEB lists the 500/517 bp doublet as one band (124 ng). Recommended 1-1.4% agarose (optimum 1.2%).',
  },
  {
    id: 'neb-100bp',
    name: '100 bp DNA Ladder',
    vendor: 'New England Biolabs',
    catalog: 'N3231S',
    source: NEB_N3231,
    bands: [
      ...bands([[1517, 45], [1200, 35], [1000, 95, E], [900, 27], [800, 24], [700, 21], [600, 18]]),
      { size: 500, massNg: 97, emphasized: true, components: [517, 500], label: '500/517' },
      ...bands([[400, 38], [300, 29], [200, 25], [100, 48]]),
    ],
    loadNg: 500, // "Mass values are for 0.5 µg/lane"; "We recommend loading 0.5 µg"
    referenceGel: '1.3% TAE agarose, ethidium bromide',
    notes: 'NEB lists the 500/517 bp doublet as one band (97 ng). Recommended 1.2-3% agarose (optimum 2%).',
  },
  {
    id: 'neb-lambda-hindiii',
    name: 'Lambda DNA-HindIII Digest',
    vendor: 'New England Biolabs',
    catalog: 'N3012S',
    source: NEB_N3012,
    // Equimolar digest of lambda cI857 ind1 Sam7 (48,502 bp): mass is proportional to size.
    bands: bands([[23130, 477], [9416, 194], [6557, 135], [4361, 90], [2322, 48], [2027, 42], [564, 12], [125, 3]]),
    loadNg: 1000, // masses "assuming a 1.0 µg load"; NEB loading protocol: 2 µl (1 µg) per 5 mm lane
    referenceGel: '1.0% agarose, ethidium bromide',
    notes:
      'The cohesive (cos) ends of the 23,130 and 4,361 bp fragments can anneal; heat to 60 °C for 3 min before ' +
      'loading to separate them (NEB product note). Recommended 0.6-1.2% agarose (optimum 0.8%).',
  },
  // ---------------------------------------------------------------- Thermo Fisher Scientific
  {
    id: 'thermo-generuler-1kb',
    name: 'GeneRuler 1 kb DNA Ladder',
    vendor: 'Thermo Fisher Scientific',
    catalog: 'SM0311',
    source: TF_SM0311,
    // Figure "bp / ng/0.5 µg" of the product information sheet (Pub. No. MAN0013004 Rev. D.00). Recommended
    // load (all four GeneRuler ladders, 0.5 µg/µl): 1 µl = 0.5 µg per 5 mm lane ("Protocol for Loading").
    bands: bands([[10000, 30], [8000, 30], [6000, 70, E], [5000, 30], [4000, 30], [3500, 30], [3000, 70, E],
      [2500, 25], [2000, 25], [1500, 25], [1000, 60, E], [750, 25], [500, 25], [250, 25]]),
    loadNg: 500,
    referenceGel: '1% agarose, 1X TAE, 7 V/cm, 45 min (8 cm gel)',
  },
  {
    id: 'thermo-generuler-1kb-plus',
    name: 'GeneRuler 1 kb Plus DNA Ladder',
    vendor: 'Thermo Fisher Scientific',
    catalog: 'SM1331',
    source: TF_SM1331,
    bands: bands([[20000, 20], [10000, 20], [7000, 20], [5000, 75, E], [4000, 20], [3000, 20], [2000, 20],
      [1500, 80, E], [1000, 25], [700, 25], [500, 75, E], [400, 25], [300, 25], [200, 25], [75, 25]]),
    loadNg: 500,
    referenceGel: '1% agarose, 1X TAE, 7 V/cm, 45 min (8 cm gel)',
  },
  {
    id: 'thermo-generuler-100bp-plus',
    name: 'GeneRuler 100 bp Plus DNA Ladder',
    vendor: 'Thermo Fisher Scientific',
    catalog: 'SM0321',
    source: TF_SM0321,
    bands: bands([[3000, 28], [2000, 28], [1500, 28], [1200, 28], [1000, 80, E], [900, 27], [800, 27], [700, 27],
      [600, 27], [500, 80, E], [400, 30], [300, 30], [200, 30], [100, 30]]),
    loadNg: 500,
    referenceGel: '1.7% agarose, 1X TBE, 5 V/cm, 1 h (8 cm gel)',
  },
  {
    id: 'thermo-generuler-mix',
    name: 'GeneRuler DNA Ladder Mix',
    vendor: 'Thermo Fisher Scientific',
    catalog: 'SM0331',
    source: TF_SM0331,
    bands: bands([[10000, 18], [8000, 18], [6000, 18], [5000, 18], [4000, 18], [3500, 18], [3000, 60, E],
      [2500, 16], [2000, 16], [1500, 16], [1200, 16], [1000, 60, E], [900, 17], [800, 17], [700, 17], [600, 17],
      [500, 60, E], [400, 20], [300, 20], [200, 20], [100, 20]]),
    loadNg: 500,
    referenceGel: '1% agarose, 1X TAE, 7 V/cm, 45 min (8 cm gel)',
  },
  {
    id: 'invitrogen-1kb-plus',
    name: '1 Kb Plus DNA Ladder',
    vendor: 'Invitrogen (Thermo Fisher Scientific)',
    catalog: '10787018',
    source: INV_10787018,
    // Product information sheet MAN0000898 Rev. A.0 (2017 formulation, 100-15,000 bp).
    bands: bands([[15000], [10000], [8000], [7000], [6000], [5000], [4000], [3000], [2000], [1500, undefined, E],
      [1000], [850], [650], [500], [400], [300], [200], [100]]),
    notes:
      'Invitrogen describes uniform band intensity with a brighter 1,500 bp reference band but publishes no ' +
      'per-band masses. For 0.7-1.2% agarose gels. The earlier product under the same catalogue number ' +
      '(10787-018, 2000 manual) had 20 different bands (1-12 kb in 1 kb steps plus 100-1,650 bp): check the ' +
      'product sheet of the lot in use.',
  },
  // ---------------------------------------------------------------- Promega
  {
    id: 'promega-1kb',
    name: '1kb DNA Ladder',
    vendor: 'Promega',
    catalog: 'G5711',
    source: PROMEGA_G5711,
    bands: [
      ...bands([[10000], [8000], [6000], [5000], [4000], [3000, undefined, E], [2500], [2000], [1500],
        [1000, undefined, E], [750], [500]]),
      { size: 250, components: [253, 250], label: '250/253' },
    ],
    notes:
      'Thirteen bands, 250-10,000 bp; the 1,000 and 3,000 bp bands are brighter, all others of equal intensity ' +
      '(product page). Fragment list (including the unresolved 250/253 bp pair) from the figure of the same ' +
      `ladder in Promega white paper WP111 (${PROMEGA_WP111}). Promega publishes no per-band masses: its ` +
      'ladders "have defined sizes, and are not intended for use in quantitative analysis".',
  },
  // ---------------------------------------------------------------- Bioneer (Korea)
  // Manual PM-338 (revision 9, 2024-11-25), "Specifications": concentration 150 / 100 / 80 / 100 ng/µl and
  // "Recommended Loading Volume" 2 / 2 / 4 / 2 µl per 5 mm lane for D-1020 / D-1030 / D-1035 / D-1040 (all
  // "0.5X TBE buffer"). Its "Size Description" tables print the band masses per 4 µl (D-1020, D-1035,
  // D-1040) or per 5 µl (D-1030); they are rescaled here to the recommended load (`loadNg`).
  {
    id: 'bioneer-1kb',
    name: '1 kb DNA Ladder',
    vendor: 'Bioneer',
    catalog: 'D-1040',
    source: BIONEER_PM338,
    // printed: ng per 4 µl (400 ng) of the 100 ng/µl ladder; recommended 2 µl = 200 ng
    bands: bands(atRecommendedLoad([[10200, 16], [8000, 16], [5991, 26], [5007, 20], [4000, 40], [2961, 60], [2000, 48],
      [1600, 54], [1000, 60], [500, 60]], 2, 4)),
    loadNg: 200,
    referenceGel: '1.0% TBE agarose, ethidium bromide',
    notes:
      'Ready-to-use (contains bromophenol blue and xylene cyanol FF); recommended load 2 µl (200 ng) per 5 mm ' +
      'lane. Band masses are for that load; the manual prints them per 4 µl (twice these values).',
  },
  {
    id: 'bioneer-100bp',
    name: '100 bp DNA Ladder',
    vendor: 'Bioneer',
    catalog: 'D-1030',
    source: BIONEER_PM338,
    // printed: ng per 5 µl (500 ng) of the 100 ng/µl ladder; recommended 2 µl = 200 ng
    bands: bands(atRecommendedLoad([[2000, 87.5], [1600, 20], [1200, 15], [1000, 88.5], [900, 28], [800, 25], [700, 31],
      [600, 18.5], [500, 88.5], [400, 16.5], [300, 26.5], [200, 24], [100, 31]], 2, 5)),
    loadNg: 200,
    referenceGel: '1.5% TBE agarose, ethidium bromide',
    notes:
      'Ready-to-use (contains bromophenol blue and xylene cyanol FF); recommended load 2 µl (200 ng) per 5 mm ' +
      'lane. Band masses are for that load; the manual prints them per 5 µl (2.5 times these values).',
  },
  {
    id: 'bioneer-100bp-plus',
    name: '100 bp Plus DNA Ladder',
    vendor: 'Bioneer',
    catalog: 'D-1035',
    source: BIONEER_PM338,
    // printed: ng per 4 µl (320 ng) of the 80 ng/µl ladder = the recommended load
    bands: bands([[10200, 6], [8000, 6], [5991, 8], [5007, 8], [4000, 8], [2961, 8], [2000, 56.6], [1600, 13.4],
      [1200, 10], [1000, 40], [900, 18], [800, 16], [700, 14], [600, 12], [500, 40], [400, 10], [300, 12], [200, 12],
      [100, 22]]),
    loadNg: 320,
    referenceGel: '1.0% TBE agarose, ethidium bromide',
    notes: 'Ready-to-use (contains bromophenol blue and xylene cyanol FF); recommended load 4 µl (320 ng) per 5 mm lane.',
  },
  {
    id: 'bioneer-25-100bp',
    name: '25/100 bp Mixed DNA Ladder',
    vendor: 'Bioneer',
    catalog: 'D-1020',
    source: BIONEER_PM338,
    // printed: ng per 4 µl (600 ng) of the 150 ng/µl ladder; recommended 2 µl = 300 ng
    bands: bands(atRecommendedLoad([[2000, 20], [1000, 40], [900, 9], [800, 8], [700, 14], [600, 6], [500, 40], [400, 12],
      [300, 12], [200, 10], [175, 16], [150, 136], [125, 32], [100, 41], [75, 96], [50, 64], [25, 44]], 2, 4)),
    loadNg: 300,
    referenceGel: '2.0% TBE agarose, ethidium bromide',
    notes:
      'Ready-to-use (contains bromophenol blue and xylene cyanol FF); recommended load 2 µl (300 ng) per 5 mm ' +
      'lane. Band masses are for that load; the manual prints them per 4 µl (twice these values).',
  },
  // ---------------------------------------------------------------- Enzynomics (Korea)
  {
    id: 'enzynomics-1kb',
    name: '1 kb DNA Ladder Marker',
    vendor: 'Enzynomics',
    catalog: 'DM002',
    source: ENZYNOMICS_DM002,
    // Product page figure / manual rev.221201: "Amount (ng/5 µl)" of the 100 µg/ml ladder. The vendor recommends
    // loading 5-10 µl (all three Enzynomics ladders); the masses are for 5 µl.
    bands: bands([[10000, 40], [8000, 40], [6000, 40], [5000, 80, E], [4000, 40], [3000, 40], [2000, 40],
      [1000, 80, E], [500, 40], [200, 40]]),
    loadNg: 500,
    referenceGel: '1% agarose',
    notes: 'The per-band amounts printed by the vendor add up to 480 ng per 5 µl (nominal 500 ng).',
  },
  {
    id: 'enzynomics-1kb-plus',
    name: '1 kb (+) DNA Ladder Marker',
    vendor: 'Enzynomics',
    catalog: 'DM003',
    source: ENZYNOMICS_DM003,
    // "Amount (ng/5 µl)" of the 150 µg/ml ladder.
    bands: bands([[10000, 40], [8000, 40], [6000, 40], [5000, 80, E], [4000, 40], [3000, 40], [2000, 80, E],
      [1500, 40], [1000, 80, E], [800, 30], [650, 30], [500, 60, E], [400, 30], [300, 30], [200, 40], [100, 40]]),
    loadNg: 750,
    referenceGel: '1% agarose',
    notes: 'The per-band amounts printed by the vendor add up to 740 ng per 5 µl (nominal 750 ng).',
  },
  {
    id: 'enzynomics-100bp',
    name: '100 bp DNA Ladder Marker',
    vendor: 'Enzynomics',
    catalog: 'DM001',
    source: ENZYNOMICS_DM001,
    // "Amount (ng/5 µl)" of the 100 µg/ml ladder.
    bands: bands([[3000, 40], [2000, 80, E], [1500, 40], [1000, 60, E], [900, 30], [800, 30], [700, 30], [600, 30],
      [500, 60, E], [400, 30], [300, 30], [200, 40], [100, 40]]),
    loadNg: 500,
    referenceGel: '1% agarose',
    notes: 'The per-band amounts printed by the vendor add up to 540 ng per 5 µl (nominal 500 ng).',
  },
  // ---------------------------------------------------------------- Takara Bio
  {
    id: 'takara-100bp',
    name: '100 bp DNA Ladder',
    vendor: 'Takara Bio',
    catalog: '3407A',
    source: TAKARA_3407A,
    // "Loading volume is 5 µl per lane. 5 µl of this product contains ~50 ng of each band, except the 500 bp
    // fragment which contains ~150 ng";
    // 11 fragments, 130 ng/µl (certificate of analysis).
    bands: bands([[1500, 50], [1000, 50], [900, 50], [800, 50], [700, 50], [600, 50], [500, 150, E], [400, 50],
      [300, 50], [200, 50], [100, 50]]),
    loadNg: 650,
    notes: 'Masses are the approximate values (~50 ng, ~150 ng) stated by the vendor for a 5 µl load.',
  },
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

/**
 * Every built-in ladder, deeply frozen and typed read-only (shared constant data: copy before
 * modifying). Order: vendor, then product, as listed in this file.
 */
export const LADDERS: readonly Ladder[] = deepFreeze(LADDER_DATA);

/** The built-in ladder with this id, or undefined. */
export function getLadder(id: string): Ladder | undefined {
  return LADDERS.find((l) => l.id === id);
}

/**
 * Mass (ng) of `band` when `loadNg` ng of the ladder are loaded instead of the vendor's recommended
 * amount (`ladder.loadNg`): `band.massNg * loadNg / ladder.loadNg`. Undefined when the vendor publishes
 * no mass for the band (`band.massNg` undefined) or the ladder has no reference load (`ladder.loadNg`
 * undefined). Never NaN.
 *
 * @throws RangeError for a negative or non-finite `loadNg`, a ladder `loadNg` that is not a finite
 *   number > 0, or a band `massNg` that is not a finite number >= 0 (custom ladders)
 */
export function bandMassAtLoad(ladder: Ladder, band: LadderBand, loadNg: number): number | undefined {
  if (!Number.isFinite(loadNg) || loadNg < 0) throw new RangeError(`load must be a finite number >= 0 ng, got ${loadNg}`);
  if (ladder.loadNg !== undefined && (!Number.isFinite(ladder.loadNg) || ladder.loadNg <= 0)) {
    throw new RangeError(`ladder '${ladder.id}': reference load (loadNg) must be a finite number > 0 ng, got ${ladder.loadNg}`);
  }
  if (band.massNg !== undefined && (!Number.isFinite(band.massNg) || band.massNg < 0)) {
    throw new RangeError(`ladder '${ladder.id}' band ${band.size} bp: mass (massNg) must be a finite number >= 0 ng, got ${band.massNg}`);
  }
  if (band.massNg === undefined || ladder.loadNg === undefined) return undefined;
  const mass = (band.massNg * loadNg) / ladder.loadNg;
  // extreme custom values: scale first so that the product cannot overflow
  return Number.isFinite(mass) ? mass : band.massNg * (loadNg / ladder.loadNg);
}
