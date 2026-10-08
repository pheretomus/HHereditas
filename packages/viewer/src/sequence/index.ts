/**
 * Sequence view: SnapGene-style annotated sequence text (the main editing surface), plus its
 * pure helpers (row model, keyboard / clipboard intents, codon mapping, a tiny translator).
 */
export { SequenceView } from './SequenceView';
export type { SequenceViewProps } from './SequenceView';
export type { FeatureClickInfo, MapTarget, SequenceEdit, SequenceViewShow } from './types';

// Row model: exact row contents and heights, hit-testing (pure, DOM-free).
export {
  DEFAULT_METRICS as SEQUENCE_VIEW_METRICS,
  autoBasesPerRow,
  buildRowModel,
  cutCounts,
  enzymeLabelText,
  gapAtPoint,
  rowAtY,
  rowOfBase,
} from './layout';
export type {
  BarPiece,
  CutMark,
  EnzymeLabel,
  FeatureLane,
  FeaturePiece,
  LayoutFeature,
  LayoutPrimer,
  OrfPiece,
  PointHit,
  PrimerPiece,
  RowGeometry,
  RowLayout,
  RowModel,
  RowModelInput,
  SequenceMetrics,
} from './layout';

// Keyboard / text / clipboard input as edit and selection intents (pure).
export {
  cleanSequenceInput,
  copyText,
  coverSelection,
  cutIntent,
  deleteIntent,
  extendBy,
  extendSelectionTo,
  keyIntent,
  selectionAfterEdit,
  textIntent,
} from './editing';
export type { CaretAffinity, EditingContext, KeyInput, KeyIntent, TextIntent } from './editing';

// Translation of CDS features under their codons.
export { buildCodingInfo, codonAtBase, codonRange, codonStartOffset } from './translation';
export type { CodingInfo } from './translation';
export { codonToAminoAcid, translateFeatureLite, translateLite } from './translate-lite';
export type { TranslateLiteOptions } from './translate-lite';
