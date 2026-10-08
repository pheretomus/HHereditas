/** Common INSDC feature keys offered by the inspector's Type pop-up, with readable names. */
export interface FeatureTypeOption {
  /** INSDC feature key, stored in Feature.type. */
  value: string;
  label: string;
}

export const COMMON_FEATURE_TYPES: readonly FeatureTypeOption[] = [
  { value: 'CDS', label: 'CDS' },
  { value: 'gene', label: 'Gene' },
  { value: 'promoter', label: 'Promoter' },
  { value: 'terminator', label: 'Terminator' },
  { value: 'rep_origin', label: 'Replication origin' },
  { value: 'RBS', label: 'Ribosome binding site' },
  { value: 'primer_bind', label: 'Primer binding site' },
  { value: 'protein_bind', label: 'Protein binding site' },
  { value: 'enhancer', label: 'Enhancer' },
  { value: 'polyA_signal', label: 'PolyA signal' },
  { value: 'LTR', label: 'LTR' },
  { value: 'sig_peptide', label: 'Signal peptide' },
  { value: 'ncRNA', label: 'ncRNA' },
  { value: 'regulatory', label: 'Regulatory' },
  { value: 'repeat_region', label: 'Repeat region' },
  { value: 'misc_feature', label: 'Misc. feature' },
];

/** Options for a feature's Type pop-up: the common types, plus the feature's own type if unusual. */
export function featureTypeOptions(current?: string): FeatureTypeOption[] {
  const options = [...COMMON_FEATURE_TYPES];
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: current });
  return options;
}

/** Readable name of a feature type ("rep_origin" → "Replication origin"). */
export function featureTypeLabel(type: string): string {
  return COMMON_FEATURE_TYPES.find((o) => o.value === type)?.label ?? type.replace(/_/g, ' ');
}

/** Readable qualifier key ("codon_start" → "Codon start"). */
export function qualifierLabel(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
