/**
 * Types shared by the linear map. `MapTarget`, `FeatureClickInfo` and `MapShowOptions` are
 * structurally identical across the three sequence visualizations (circular map, linear map,
 * sequence view) so the app can handle their callbacks with one code path.
 */
import type { EnzymeSite, Orf } from '@hhereditas/core';

/**
 * What is under the pointer (hover, click, context menu).
 * - `background`: empty space; `position` is the nearest gap position (0..length).
 * - `sequence`: the backbone itself; `position` is the 0-based base index under the pointer.
 */
export type MapTarget =
  | { kind: 'feature'; id: string }
  | { kind: 'enzyme'; site: EnzymeSite }
  | { kind: 'primer'; id: string }
  | { kind: 'orf'; orf: Orf }
  | { kind: 'background'; position: number }
  | { kind: 'sequence'; position: number };

/** Modifier state passed to `onFeatureClick`. `clickCount` is 2 for a double click. */
export interface FeatureClickInfo {
  clickCount: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** Which layers to draw. Every layer defaults to visible when its data is given. */
export interface MapShowOptions {
  features?: boolean;
  enzymes?: boolean;
  primers?: boolean;
  orfs?: boolean;
  alignments?: boolean;
  /** Append `(N bp)` length to feature and primer labels. */
  lengths?: boolean;
  /** Prefix primer labels with `(start .. end) ` 1-based binding coordinates. */
  primerLocations?: boolean;
}
