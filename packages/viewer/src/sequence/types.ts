/**
 * Public types of the sequence view. `MapTarget` and `FeatureClickInfo` are structurally
 * identical across the three sequence visualizations (circular map, linear map, sequence
 * view) so the app can handle their callbacks with one code path.
 */
import type { EnzymeSite, Orf, Range } from '@hhereditas/core';

/**
 * What the pointer is on (context menu).
 * - `sequence`: a base of the top or bottom strand; `position` is its 0-based base index.
 * - `background`: anything else in a row (margins, empty lanes); `position` is the nearest gap.
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

/**
 * An edit the user asked for. The view never changes the record itself: the app applies the
 * edit (e.g. with the core `insertBases` / `deleteRange` / `replaceRange`) and passes the new
 * record back. Ranges follow the types.ts conventions (they may wrap the origin on circular
 * records, end > length). `bases` are clean upper-case IUPAC letters of the record's alphabet
 * (DNA; U instead of T for RNA records; one-letter amino acids and * for protein records).
 * On circular records an insertion at gap 0 is the same as one at gap L (the core appends it).
 */
export type SequenceEdit =
  | { kind: 'insert'; gap: number; bases: string }
  | { kind: 'delete'; range: Range }
  | { kind: 'replace'; range: Range; bases: string };

/** Which layers the sequence view draws. */
export interface SequenceViewShow {
  /** Bottom strand under the top strand (default true; always off for protein records). */
  complement?: boolean;
  /** Feature bars (default true). */
  features?: boolean;
  /** Enzyme names and cut marks for the given sites (default true). */
  enzymes?: boolean;
  /** Primer binding sites (default true). */
  primers?: boolean;
  /** Amino-acid translation under CDS features (default true). */
  translations?: boolean;
  /** ORF arrows for the given ORFs (default true). */
  orfs?: boolean;
  /** Row start positions in the left margin (default true). */
  numbering?: boolean;
}
