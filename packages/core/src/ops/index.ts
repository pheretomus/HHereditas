/**
 * Immutable editing operations on SeqRecord, used by the editor UI and by cloning simulations:
 * base edits with feature-coordinate remapping, whole-record transforms and CRUD helpers.
 *
 * Coordinates follow types.ts (0-based, half-open, origin-crossing ranges with end > L on
 * circular molecules, gap positions in [0, L]); lengths are in bases. See `remap.ts` for the
 * exact feature-remapping rules. Every function is pure: inputs are never modified and results
 * share no mutable object with them.
 */
export { insertBases, deleteRange, replaceRange } from './edit';
export { extractRange, rotateOrigin, reverseComplementRecord, setTopology, concatRecords } from './transform';
/** Options of extractRange (name, description) and concatRecords (topology, name). */
export type { ExtractOptions, ConcatOptions } from './transform';
export { planEdit, remapFeatures, remapRange, remapGap } from './remap';
/** Position-only edit description, its validated layout, and the caret side for remapGap. */
export type { SequenceEdit, EditPlan, GapBias } from './remap';
export { addFeature, updateFeature, removeFeature, addPrimer, updatePrimer, removePrimer } from './crud';
/** Field patches accepted by updateFeature / updatePrimer (any field except the id). */
export type { FeaturePatch, PrimerPatch } from './crud';
