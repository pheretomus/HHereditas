/**
 * INSDC feature keys, the list SnapGene offers and writes to .dna files. The key itself is what the Type pop-up
 * shows and what Feature.type holds, so a type survives a round trip through a file unchanged.
 */
export interface FeatureTypeOption {
  /** INSDC feature key, stored in Feature.type. */
  value: string;
  label: string;
}

export const FEATURE_TYPES: readonly string[] = [
  '-10_signal',
  '-35_signal',
  "3'UTR",
  "5'UTR",
  'assembly_gap',
  'attenuator',
  'C_region',
  'CAAT_signal',
  'CDS',
  'centromere',
  'conflict',
  'D-loop',
  'D_segment',
  'enhancer',
  'exon',
  'gap',
  'GC_signal',
  'gene',
  'iDNA',
  'intron',
  'J_segment',
  'LTR',
  'mat_peptide',
  'misc_binding',
  'misc_difference',
  'misc_feature',
  'misc_recomb',
  'misc_RNA',
  'misc_signal',
  'misc_structure',
  'mobile_element',
  'modified_base',
  'mRNA',
  'N_region',
  'ncRNA',
  'old_sequence',
  'operon',
  'oriT',
  'polyA_signal',
  'polyA_site',
  'precursor_RNA',
  'prim_transcript',
  'primer_bind',
  'promoter',
  'propeptide',
  'proprotein',
  'protein_bind',
  'RBS',
  'regulatory',
  'rep_origin',
  'repeat_region',
  'rRNA',
  'S_region',
  'sig_peptide',
  'source',
  'stem_loop',
  'STS',
  'TATA_signal',
  'telomere',
  'terminator',
  'tmRNA',
  'transit_peptide',
  'tRNA',
  'unsure',
  'V_region',
  'V_segment',
  'variation',
];

/** Options for a feature's Type pop-up: every INSDC key, plus the feature's own type if it is not one of them. */
export function featureTypeOptions(current?: string): FeatureTypeOption[] {
  const options = FEATURE_TYPES.map((value) => ({ value, label: value }));
  if (current && !FEATURE_TYPES.includes(current)) options.push({ value: current, label: current });
  return options;
}

/** Readable name of a feature type ("rep_origin" -> "Replication origin"), for prose. */
const READABLE: Readonly<Record<string, string>> = {
  CDS: 'CDS',
  gene: 'Gene',
  promoter: 'Promoter',
  terminator: 'Terminator',
  rep_origin: 'Replication origin',
  RBS: 'Ribosome binding site',
  primer_bind: 'Primer binding site',
  protein_bind: 'Protein binding site',
  enhancer: 'Enhancer',
  polyA_signal: 'PolyA signal',
  LTR: 'LTR',
  sig_peptide: 'Signal peptide',
  ncRNA: 'ncRNA',
  regulatory: 'Regulatory',
  repeat_region: 'Repeat region',
  misc_feature: 'Misc. feature',
};

export function featureTypeLabel(type: string): string {
  return READABLE[type] ?? type.replace(/_/g, ' ');
}

/** Readable qualifier key ("codon_start" → "Codon start"). */
export function qualifierLabel(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
