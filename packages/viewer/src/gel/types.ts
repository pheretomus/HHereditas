/**
 * Data model of the virtual agarose gel. The view is pure presentation: band positions and
 * intensities are computed by the gel model in @hhereditas/core (whose `GelBand` objects can be
 * passed in as they are: they are structurally compatible with {@link GelLaneBand}).
 *
 * Brightness: `intensity` is relative within its lane (the core normalises each lane to its
 * brightest band). To make lanes comparable (a lane holding only a faint primer dimer must not glow
 * like a strong product), give absolute amounts: `massNg` on every band of a lane, or the lane's
 * `loadNg`. Lanes with amounts then share one brightness scale (the heaviest band of the gel is the
 * brightest); lanes without amounts are drawn from their own intensities.
 */

/** Conformation of the DNA in a band (uncut plasmids run as several forms). */
export type GelDnaForm = 'linear' | 'supercoiled' | 'nicked';

/** One visible band of a lane. */
export interface GelLaneBand {
  /** Size of the band in bp (for co-migrating fragments: their representative / mean size). */
  size: number;
  /**
   * Migration distance: 0 = the well .. 1 = the bottom of the gel. Negative values are drawn in the
   * well; bands below the bottom of the gel (ran off) are not drawn.
   */
  position: number;
  /**
   * Relative brightness 0..1 within the lane (1 = brightest band of the lane), proportional to the
   * band's DNA mass. Bands of intensity 0 are invisible. See the module comment for comparing lanes.
   */
  intensity: number;
  /** Number of co-migrating fragments merged into this band. Default 1. */
  count?: number;
  /** Labels of the fragments in the band, e.g. 'EcoRI – BamHI' (shown in the hover tooltip). */
  labels?: readonly string[];
  /** Ladder reference band (the vendor loads more DNA there): its size label is drawn bolder. */
  emphasized?: boolean;
  /** Sizes (bp) of the merged fragments, largest first (labels and tooltip of co-migrating bands). Optional. */
  sizes?: readonly number[];
  /**
   * DNA mass in the band (ng), e.g. from a ladder's vendor data (shown in the tooltip). When every
   * band of a lane has one, the lane's brightness is drawn on the gel-wide scale. Optional.
   */
  massNg?: number;
  /**
   * Conformation, for bands of uncut (circular) DNA: 'supercoiled' and 'nicked' (open circular)
   * bands are marked 'SC' / 'OC' next to their size. Default: linear (no mark).
   */
  form?: GelDnaForm;
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
  /**
   * Total DNA loaded in the lane (ng), shared out over its bands in proportion to their intensities.
   * Puts the lane on the gel-wide brightness scale (unless every band has its own `massNg`). Optional.
   */
  loadNg?: number;
}

/**
 * Which sizes are written on the gel: 'ladder' = the sizes of the (first) ladder at the left of the
 * gel (without a ladder lane, the sample bands are labelled instead, so a gel always has a scale);
 * 'all' = also a size next to every sample band; 'none' = no size labels (tooltips only).
 */
export type GelSizeLabels = 'ladder' | 'all' | 'none';
