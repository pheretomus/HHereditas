/**
 * Feature colours. Every visualization colours features the same way: a user-chosen
 * feature.color wins; otherwise the colour comes from the feature type via the
 * --hh-feature-* design tokens (light/dark aware).
 *
 * Colours are CSS values (often `var(--…)`), so apply them through `style={{ fill }}` or
 * CSS, not SVG presentation attributes (WebKit does not resolve var() in attributes).
 */
import type { Feature } from '@hhereditas/core';

const TYPE_TOKEN: Readonly<Record<string, string>> = {
  CDS: 'cds',
  gene: 'gene',
  mRNA: 'gene',
  exon: 'gene',
  '5\'UTR': 'regulatory',
  '3\'UTR': 'regulatory',
  promoter: 'promoter',
  terminator: 'terminator',
  rep_origin: 'rep-origin',
  oriT: 'rep-origin',
  primer_bind: 'primer-bind',
  primer: 'primer-bind',
  RBS: 'rbs',
  ribosome_binding_site: 'rbs',
  protein_bind: 'protein-bind',
  misc_binding: 'protein-bind',
  enhancer: 'enhancer',
  polyA_signal: 'polya',
  polyA_site: 'polya',
  LTR: 'ltr',
  mobile_element: 'ltr',
  sig_peptide: 'sig-peptide',
  mat_peptide: 'sig-peptide',
  transit_peptide: 'sig-peptide',
  ncRNA: 'rna',
  misc_RNA: 'rna',
  rRNA: 'rna',
  tRNA: 'rna',
  regulatory: 'regulatory',
  repeat_region: 'repeat',
  misc_feature: 'misc',
};

/** Token name (suffix of --hh-feature-*) used for a feature type. */
export function featureColorToken(type: string): string {
  return TYPE_TOKEN[type] ?? 'misc';
}

/** CSS colour for a feature type, e.g. 'var(--hh-feature-cds)'. */
export function featureTypeColor(type: string): string {
  return `var(--hh-feature-${featureColorToken(type)})`;
}

/** CSS fill colour for a feature (custom colour first, then the type colour). */
export function featureFill(feature: Pick<Feature, 'type' | 'color' | 'strand' | 'reverseColor'>): string {
  if (feature.strand === -1 && feature.reverseColor) return feature.reverseColor;
  return feature.color ?? featureTypeColor(feature.type);
}

/**
 * Stroke/darker variant of a fill, for outlines and arrowheads.
 * Uses CSS color-mix (WebView2, WebKitGTK and Safari ≥ 16.2 support it).
 */
export function featureStroke(fill: string): string {
  return `color-mix(in srgb, ${fill} 72%, black)`;
}

/**
 * Text colour that stays readable on top of a feature fill. Feature fills are mid-tone
 * pastels in both themes, so near-black text is used on them.
 */
export const FEATURE_LABEL_ON_FILL = 'rgba(0, 0, 0, 0.82)';
