/**
 * Virtual agarose gels: commercial DNA ladders, a calibrated migration model and lane simulation.
 * Positions are fractions of the gel length from the well (0) to the bottom of a standard run (1);
 * sizes are in base pairs. See `migration.ts` for the model and its sources.
 */
export { LADDERS, bandMassAtLoad, getLadder } from './ladders';
export type { Ladder, LadderBand } from './ladders';
export {
  AGAROSE_PERCENT_RANGE,
  BPB_POSITION,
  BPB_XC_SPEED_RATIO,
  DEFAULT_AGAROSE_PERCENT,
  DYE_COMIGRATION_BP,
  DYE_FRONT_POSITIONS,
  FORM_SIZE_FACTOR,
  RESOLVING_WINDOW_BP,
  SHAPE_EXPONENT,
  SMALL_DNA_POSITION,
  formSizeFactor,
  gelParameters,
  migrate,
  positionOnGel,
  resolvingWindow,
  sizeAtPosition,
} from './migration';
export type { DnaForm, GelBuffer, GelConditions, GelParameters, MigrationOptions } from './migration';
export { DEFAULT_RESOLUTION, ladderLane, simulateLane } from './lane';
export type { GelBand, GelFragment, LaneOptions } from './lane';
