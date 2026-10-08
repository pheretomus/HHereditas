/**
 * Sequence view: SnapGene-style annotated sequence text (the main editing surface), plus its
 * pure helpers (row model, keyboard / clipboard intents, codon mapping, a tiny translator).
 */
export { SequenceView } from './SequenceView';
export type { SequenceViewProps } from './SequenceView';
export type { FeatureClickInfo, MapTarget, SequenceEdit, SequenceViewShow } from './types';
export {
  DEFAULT_METRICS as SEQUENCE_VIEW_METRICS,
  autoBasesPerRow,
  baseAtPoint,
  buildRowModel,
  colCenter,
  colLeft,
  colRight,
  cutCounts,
  cutLabelNumber,
  enzymeLabelText,
  gapAtPoint,
  gapX,
  rangeColsInRow,
  rowAtY,
  rowOfBase,
  rowOfGap,
  xToCol,
  xToGap,
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
export {
  caretGap,
  cleanSequenceInput,
  copyText,
  coverSelection,
  cutIntent,
  deleteIntent,
  extendBy,
  extendSelectionTo,
  insertIntent,
  keyIntent,
  selectionAfterEdit,
  textIntent,
} from './editing';
export type { CaretAffinity, EditingContext, KeyInput, KeyIntent, TextIntent } from './editing';
export { buildCodingInfo, codonAtBase, codonRange, codonStartOffset } from './translation';
export type { CodingInfo } from './translation';
export { codonToAminoAcid, translateFeatureLite, translateLite } from './translate-lite';
export type { TranslateLiteOptions } from './translate-lite';
