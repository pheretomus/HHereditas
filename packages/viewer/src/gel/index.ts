/** Virtual agarose gel: <GelView />, <GelThumbnail /> and their layout helpers. */
export { GelView } from './GelView';
export type { GelViewProps } from './GelView';
export { GelThumbnail } from './GelThumbnail';
export type { GelThumbnailProps } from './GelThumbnail';
export type { GelLane, GelLaneBand, GelSizeLabels } from './types';
export {
  GEL_MAX_LANE_WIDTH,
  GEL_SMEAR_THRESHOLD,
  computeGelLayout,
  gelBandAlpha,
  gelBandGlow,
  gelBandThickness,
  gelLaneAt,
  gelPositionToY,
  gelSmearAlpha,
  gelYToPosition,
  hitTestGel,
  placeGelLabels,
} from './layout';
export type {
  GelBandGeometry,
  GelHeaderLabel,
  GelHeaderLayout,
  GelHeaderMode,
  GelHit,
  GelLabelPlacementOptions,
  GelLabelTarget,
  GelLadderLabel,
  GelLadderTick,
  GelLaneGeometry,
  GelLayout,
  GelLayoutOptions,
  GelPlacedLabel,
  GelRect,
  GelScale,
  GelSizeLabel,
  GelSmearSegment,
} from './layout';
export {
  describeGelBand,
  describeGelSmear,
  formatAgarose,
  formatGelSize,
  formatGelSizeRange,
  gelDescriptionText,
  gelLaneAriaLabel,
  gelLaneName,
} from './format';
export type { GelBandDescription } from './format';
export { approximateGelTextWidth, createGelTextMeasurer } from './measure';
export type { GelTextMeasurer, GelTextRole } from './measure';
