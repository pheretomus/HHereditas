/**
 * Circular (plasmid) map: <CircularMap /> and its pure (DOM-free) helpers.
 *
 * MapTarget, FeatureClickInfo and MapShowOptions are structurally identical to the types of the
 * same names exported by the linear map and the sequence view (one shared callback contract).
 * The helpers are exported under circular-specific names so a package barrel can re-export
 * every visualization folder without name clashes.
 */
export { CircularMap } from './CircularMap';
export type { CircularMapProps } from './CircularMap';
export type { FeatureClickInfo, MapShowOptions, MapTarget } from './types';

// Position <-> angle mapping (degrees clockwise from 12 o'clock; rotation and linear gap aware).
export {
  type AngleScale as CircularAngleScale,
  angleToGap as circularAngleToGap,
  angleToPosition as circularAngleToPosition,
  createAngleScale as createCircularAngleScale,
  positionToAngle as circularPositionToAngle,
} from './geometry';

// Layout in memoizable stages: model (lanes, labels) -> geometry (size dependent) -> labels.
export {
  type LabelPlacement as CircularLabelPlacement,
  type MapGeometry as CircularMapGeometry,
  type MapModel as CircularMapModel,
  buildMapModel as buildCircularMapModel,
  computeGeometry as computeCircularGeometry,
  placeLabels as placeCircularLabels,
} from './layout';
