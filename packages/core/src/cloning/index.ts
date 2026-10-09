/**
 * Cloning simulations: PCR, restriction digest of records, ligation, restriction cloning, Gibson
 * assembly (and its primer design), Golden Gate assembly, and DNA amount calculators.
 *
 * Every simulation returns a {@link CloningOutcome}-shaped object (`product`, `products`,
 * `warnings`, `error`) and never throws for user-level problems. Coordinates follow `types.ts`.
 */
export type { CloningOutcome } from './result';
export { pcr } from './pcr';
export type { PcrAmplicon, PcrOptions, PcrResult } from './pcr';
export { digestRecord } from './digest-record';
export type { DigestedRecord } from './digest-record';
export { endsCompatible, ligate } from './ligation';
export type { LigateOptions, LigationJunction, LigationResult } from './ligation';
export { restrictionClone } from './restriction-cloning';
export type { CloningJunction, CloningResult, RestrictionCloneOptions } from './restriction-cloning';
export { GIBSON_OVERLAP_TM_RANGE, designGibsonPrimers, gibsonAssembly, terminalOverlap } from './gibson';
export type { AssemblyJunction, AssemblyResult, GibsonDesign, GibsonDesignOptions, GibsonOptions } from './gibson';
export { goldenGate } from './golden-gate';
export type { GoldenGateOptions, GoldenGateResult } from './golden-gate';
export {
  DS_DNA_DALTONS_PER_BP,
  SS_DNA_DALTONS_PER_NT,
  assemblyAmounts,
  dnaNg,
  dnaPmol,
  insertAmountForRatio,
} from './calculators';
export type { AssemblyAmountRow, AssemblyAmounts, AssemblyAmountsOptions, AssemblyFragmentInput } from './calculators';
