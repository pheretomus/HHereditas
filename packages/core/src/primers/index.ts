/**
 * Primers: melting temperature, binding sites, simple design and secondary-structure checks.
 * See each file for coordinate conventions and units.
 */
export {
  DEFAULT_TM_CONDITIONS,
  TM_EXACT_EXPANSION_LIMIT,
  TM_SAMPLE_SIZE,
  divalentToMonovalentMilliMolar,
  oligoGcContent,
  resolveTmConditions,
  sodiumEquivalentMilliMolar,
  thermo,
  tm,
  tmExtremes,
  tmRange,
  tmResolved,
} from './tm';
export type { DuplexThermo, SaltCorrectionMethod, TmConditions, TmExtreme, TmRange } from './tm';

export { DEFAULT_BINDING_OPTIONS, findAllBindingSites, findBindingSites, scanBindingSites } from './binding';
export type { BindingOptions, BindingScan, PrimerBindingFailure } from './binding';

export { DEFAULT_PRIMER_DESIGN, MAX_DESIGN_PRIMER_LENGTH, designPrimer, designPrimerPair } from './design';
export type {
  DesignedPrimer,
  DesignedPrimerPair,
  PrimerDesignOptions,
  SinglePrimerDesignOptions,
} from './design';

export { analyzePrimer, endStability, hairpin, heterodimer, homodimer } from './analysis';
export type { PrimerAnalysis, SecondaryStructure, StructureOptions } from './analysis';

export { THAL_MAX_ALIGN, THAL_MAX_SEQ } from './thal';
