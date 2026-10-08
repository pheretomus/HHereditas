import type { EnzymeSite, Orf } from '@hhereditas/core';

/**
 * What the pointer is on, reported with context-menu events. Shared by every sequence
 * visualization (circular map, linear map, sequence view): keep it structurally identical.
 *
 * - feature / primer: ids (`primer.id` = PrimerBindingSite.primerId).
 * - background: empty space; `position` is the GAP position under the pointer angle.
 * - sequence: the ring area of the map (the sequence itself, no annotation under the
 *   pointer); `position` is the 0-based BASE index under the pointer.
 */
export type MapTarget =
  | { kind: 'feature'; id: string }
  | { kind: 'enzyme'; site: EnzymeSite }
  | { kind: 'primer'; id: string }
  | { kind: 'orf'; orf: Orf }
  | { kind: 'background'; position: number /* gap */ }
  | { kind: 'sequence'; position: number };

/** Modifier state and click count reported with onFeatureClick. */
export interface FeatureClickInfo {
  /** 1 for a single click, 2 for a double click, ... (MouseEvent.detail). */
  clickCount: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** Which annotation layers to draw. Every layer defaults to visible when its data is given. */
export interface MapLayers {
  features?: boolean;
  enzymes?: boolean;
  primers?: boolean;
  orfs?: boolean;
}
