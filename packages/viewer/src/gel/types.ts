/**
 * Data model of the virtual agarose gel. The view is pure presentation: band positions and
 * intensities are computed by the gel model in @hhereditas/core (whose `GelBand` objects can be
 * passed in as they are: they are structurally compatible with {@link GelLaneBand}).
 */

/** One visible band of a lane. */
export interface GelLaneBand {
  /** Size of the band in bp (for co-migrating fragments: their representative / mean size). */
  size: number;
  /**
   * Migration distance: 0 = the well .. 1 = the bottom of the gel. Negative values are drawn in the
   * well; bands below the bottom of the gel (ran off) are not drawn.
   */
  position: number;
  /** Relative brightness 0..1 (1 = brightest band of the lane). Bands of intensity 0 are invisible. */
  intensity: number;
  /** Number of co-migrating fragments merged into this band. Default 1. */
  count?: number;
  /** Labels of the fragments in the band, e.g. 'EcoRI – BamHI' (shown in the hover tooltip). */
  labels?: readonly string[];
  /** Ladder reference band (the vendor loads more DNA there): its size label is drawn bolder. */
  emphasized?: boolean;
  /** Sizes (bp) of the merged fragments, largest first (tooltip of co-migrating bands). Optional. */
  sizes?: readonly number[];
  /** DNA mass in the band (ng), e.g. from a ladder's vendor data (shown in the tooltip). Optional. */
  massNg?: number;
}

/** One lane of the gel. */
export interface GelLane {
  /** Stable identifier, reported by `onLaneClick` / `onBandHover`. */
  id: string;
  /** Text above the lane, e.g. 'EcoRI + BamHI' or '1 kb ladder'. */
  label: string;
  kind: 'ladder' | 'sample';
  /** Bands in any order. */
  bands: readonly GelLaneBand[];
}

/**
 * Which sizes are written on the gel: 'ladder' = the sizes of the (first) ladder at the left of the
 * gel; 'all' = also a size next to every sample band; 'none' = no size labels (tooltips only).
 */
export type GelSizeLabels = 'ladder' | 'all' | 'none';
