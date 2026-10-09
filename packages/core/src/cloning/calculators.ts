/**
 * DNA amount calculators for ligation and assembly planning.
 *
 * MASS CONVENTION: average mass per base pair of dsDNA = 650 g/mol (Da) per bp, the value of the
 * NEBuilder HiFi DNA Assembly protocol (New England Biolabs, E2621: "pmols = (weight in ng) x 1,000 /
 * (base pairs x 650 daltons)"; its examples: 50 ng of 5000 bp dsDNA ≈ 0.015 pmol, 50 ng of 500 bp
 * ≈ 0.15 pmol). Single-stranded DNA: 330 g/mol per nucleotide (Thermo Fisher "DNA and RNA molecular
 * weights and conversions" rule of thumb). These averages ignore the sequence and the 5'/3' end
 * groups (< 0.1 % for fragments > 100 bp); NEBioCalculator's exact formula (617.96 g/mol/bp + 36.04)
 * gives values about 5 % higher in pmol.
 *
 * Units: mass in ng, amounts in pmol, lengths in bp (nt for single strands), volumes in µl,
 * concentrations in ng/µl.
 */

/** Average dsDNA mass per base pair, g/mol (NEB NEBuilder protocol). */
export const DS_DNA_DALTONS_PER_BP = 650;
/** Average ssDNA mass per nucleotide, g/mol (Thermo Fisher conversion rule). */
export const SS_DNA_DALTONS_PER_NT = 330;

function perUnit(doubleStranded: boolean): number {
  return doubleStranded ? DS_DNA_DALTONS_PER_BP : SS_DNA_DALTONS_PER_NT;
}

function checkPositive(value: number, what: string): void {
  if (!(Number.isFinite(value) && value > 0)) throw new RangeError(`${what} must be a positive number, got ${String(value)}`);
}

function checkNonNegative(value: number, what: string): void {
  if (!(Number.isFinite(value) && value >= 0)) throw new RangeError(`${what} must be a finite number >= 0, got ${String(value)}`);
}

/**
 * Amount in pmol of `ng` nanograms of DNA of `lengthBp` bases (pairs):
 * pmol = ng × 1000 / (length × 650) for dsDNA (330 per nt for ssDNA).
 * Throws a RangeError for a negative mass or a non-positive length.
 */
export function dnaPmol(ng: number, lengthBp: number, doubleStranded = true): number {
  checkNonNegative(ng, 'ng');
  checkPositive(lengthBp, 'lengthBp');
  return (ng * 1000) / (lengthBp * perUnit(doubleStranded));
}

/** Mass in ng of `pmol` picomoles of DNA of `lengthBp` bases (pairs); inverse of {@link dnaPmol}. */
export function dnaNg(pmol: number, lengthBp: number, doubleStranded = true): number {
  checkNonNegative(pmol, 'pmol');
  checkPositive(lengthBp, 'lengthBp');
  return (pmol * lengthBp * perUnit(doubleStranded)) / 1000;
}

/**
 * Insert mass (ng) giving an insert:vector MOLAR ratio of `molarRatio` with `vectorNg` of vector:
 * insertNg = vectorNg × (insertLength / vectorLength) × molarRatio (NEB Ligation Calculator formula;
 * independent of the mass-per-bp convention). Example (NEB): 50 ng of a 3 kb vector, 1 kb insert, 3:1
 * gives 50 ng of insert.
 */
export function insertAmountForRatio(options: { vectorNg: number; vectorLengthBp: number; insertLengthBp: number; molarRatio: number }): number {
  const { vectorNg, vectorLengthBp, insertLengthBp, molarRatio } = options;
  checkNonNegative(vectorNg, 'vectorNg');
  checkPositive(vectorLengthBp, 'vectorLengthBp');
  checkPositive(insertLengthBp, 'insertLengthBp');
  checkPositive(molarRatio, 'molarRatio');
  return vectorNg * (insertLengthBp / vectorLengthBp) * molarRatio;
}

/** One fragment of an assembly plan. */
export interface AssemblyFragmentInput {
  name?: string;
  lengthBp: number;
  /** Stock concentration in ng/µl; when given, the volume to pipette is computed. */
  concentrationNgPerUl?: number;
}

/** Options of {@link assemblyAmounts}. */
export interface AssemblyAmountsOptions {
  vector: AssemblyFragmentInput;
  inserts: readonly AssemblyFragmentInput[];
  /**
   * Vector amount in ng. Default: 50 ng (the low end of NEB's 50-100 ng) for 1-2 inserts; for 3 or more
   * inserts, the mass giving 0.05 pmol so that the equimolar total lies in NEB's 0.2-0.5 pmol range.
   */
  vectorNg?: number;
  /**
   * Insert:vector molar ratio for each insert. Default (NEBuilder protocol): 2 for 1-2 inserts, 1
   * (equimolar) for 3 or more; inserts shorter than 200 bp always get 5 unless a ratio is given.
   */
  insertRatio?: number;
  /** Maximum total DNA volume, µl (NEBuilder: 10 µl in a 20 µl reaction with 2× master mix). Default 10. */
  maxDnaVolumeUl?: number;
}

/** One row of an assembly plan. */
export interface AssemblyAmountRow {
  name: string;
  role: 'vector' | 'insert';
  lengthBp: number;
  /** Molar ratio to the vector (1 for the vector). */
  ratio: number;
  pmol: number;
  ng: number;
  /** Volume of stock to add, µl (only when the concentration is known). */
  volumeUl?: number;
}

/** Result of {@link assemblyAmounts}. */
export interface AssemblyAmounts {
  rows: AssemblyAmountRow[];
  totalPmol: number;
  /** Sum of the known volumes, µl. */
  totalVolumeUl: number;
  /** Recommended total range for this number of fragments, pmol (NEBuilder protocol). */
  recommendedTotalPmol: { min: number; max: number };
  warnings: string[];
}

/**
 * Plan DNA amounts for a NEBuilder HiFi / Gibson assembly (NEB E2621 protocol): vector:insert 1:2 for
 * 2-3 fragments (total 0.03-0.2 pmol), 1:1 for 4-6 fragments (total 0.2-0.5 pmol), 5-fold excess for
 * inserts shorter than 200 bp. Warns when the total lies outside the recommended range, when more than
 * 6 fragments are planned, or when the DNA volume exceeds `maxDnaVolumeUl`.
 */
export function assemblyAmounts(options: AssemblyAmountsOptions): AssemblyAmounts {
  const { vector, inserts } = options;
  const warnings: string[] = [];
  checkPositive(vector.lengthBp, 'vector.lengthBp');
  for (const ins of inserts) checkPositive(ins.lengthBp, 'insert lengthBp');
  const fragmentCount = inserts.length + 1;
  const many = fragmentCount >= 4;
  const recommended = many ? { min: 0.2, max: 0.5 } : { min: 0.03, max: 0.2 };
  if (fragmentCount > 6) warnings.push(`${fragmentCount} fragments: NEB's guidance covers up to 6; expect lower efficiency`);
  const vectorNg = options.vectorNg ?? (many ? dnaNg(0.05, vector.lengthBp) : 50);
  checkNonNegative(vectorNg, 'vectorNg');
  if (options.insertRatio !== undefined) checkPositive(options.insertRatio, 'insertRatio');
  const vectorPmol = dnaPmol(vectorNg, vector.lengthBp);
  const rows: AssemblyAmountRow[] = [row(vector, 'vector', 1, vectorPmol, 'vector')];
  inserts.forEach((ins, i) => {
    const ratio = options.insertRatio ?? (ins.lengthBp < 200 ? 5 : many ? 1 : 2);
    rows.push(row(ins, 'insert', ratio, vectorPmol * ratio, `insert ${i + 1}`));
  });
  const totalPmol = rows.reduce((s, r) => s + r.pmol, 0);
  const totalVolumeUl = rows.reduce((s, r) => s + (r.volumeUl ?? 0), 0);
  if (totalPmol < recommended.min || totalPmol > recommended.max) {
    warnings.push(`Total DNA ${totalPmol.toFixed(3)} pmol is outside the recommended ${recommended.min}-${recommended.max} pmol for ${fragmentCount} fragments`);
  }
  const maxVol = options.maxDnaVolumeUl ?? 10;
  if (totalVolumeUl > maxVol) warnings.push(`DNA volume ${totalVolumeUl.toFixed(1)} µl exceeds ${maxVol} µl: concentrate the DNA or scale the reaction`);
  return { rows, totalPmol, totalVolumeUl, recommendedTotalPmol: recommended, warnings };
}

function row(f: AssemblyFragmentInput, role: 'vector' | 'insert', ratio: number, pmol: number, fallbackName: string): AssemblyAmountRow {
  const ng = dnaNg(pmol, f.lengthBp);
  const out: AssemblyAmountRow = { name: f.name ?? fallbackName, role, lengthBp: f.lengthBp, ratio, pmol, ng };
  if (f.concentrationNgPerUl !== undefined) {
    checkPositive(f.concentrationNgPerUl, 'concentrationNgPerUl');
    out.volumeUl = ng / f.concentrationNgPerUl;
  }
  return out;
}
