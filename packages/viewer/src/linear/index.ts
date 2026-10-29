/**
 * Linear map: horizontal map of a sequence record (linear records, and circular ones drawn
 * from the origin).
 */
export { ALIGNMENT_REVEAL, LinearMap } from './LinearMap';
export type { LinearMapProps, MapWidthChange } from './LinearMap';
export type { FeatureClickInfo, MapShowOptions, MapTarget } from './types';
export {
  LETTER_PX_PER_BASE,
  MAX_PX_PER_BASE,
  clampViewport,
  fullViewport,
  interpolateViewport,
  isFullViewport,
  panViewport,
  viewportForRange,
  zoomViewport,
} from './viewport';
