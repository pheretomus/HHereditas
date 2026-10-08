MODULE KEY: ops
OWNERSHIP: packages/core/src/ops/** (edit.ts, transform.ts, remap.ts, crud.ts, index.ts, *.test.ts).

Immutable editing operations on SeqRecord used by the editor UI and by cloning simulations. Never mutate inputs (deep-freeze inputs in tests to prove it). Feature-coordinate remapping is the heart of this module: get circular and wrapping cases right.

API:
  insertBases(rec: SeqRecord, gap: number, insert: string | SeqRecord): SeqRecord
     // insert raw bases (normalized with normalizeDna; throw an Error with a clear message on invalid characters — the UI validates first) or another record (its features are carried along, shifted). gap in [0, L].
     // Feature rule: a segment [s,e) with e <= gap is unchanged; s >= gap is shifted by n; s < gap < e grows by n (insertion inside a feature extends it). On circular records gaps 0 and L are the same place: treat an insertion at gap 0 as appending at L (the origin stays at the original first base), so a wrapping segment (e > L) grows.
  deleteRange(rec: SeqRecord, range: Range): SeqRecord
     // removes the bases in range (may wrap on circular records: define and document precisely where the new origin is; a simple consistent rule: the new sequence starts at the first base after the deleted region... or keep the original origin's base when it survives: choose the rule that keeps the most coordinates stable and document it). Segments fully inside the deleted region disappear; a feature without segments is removed; partially deleted segments are trimmed (partial flags unchanged).
  replaceRange(rec, range, replacement: string | SeqRecord): SeqRecord
     // delete then insert at range.start, except that a feature strictly containing the replaced region (s < range.start and range.end < e) keeps covering the replacement.
  extractRange(rec, range: Range, options?: { name?: string }): SeqRecord
     // linear sub-record of the bases in range (may wrap on circular parents). Overlapping features are clipped; clipped ends get partialStart/partialEnd = true (top-strand left/right semantics, consistent with GenBank '<'/'>'); non-overlapping features dropped; primers copied; ends blunt; meta copied minus accession/version; topology 'linear'.
  rotateOrigin(rec, newOrigin: number): SeqRecord   // circular only (throw on linear); the base at newOrigin becomes base 0; every feature re-based (wrapping as needed).
  reverseComplementRecord(rec): SeqRecord   // flips seq, features (strand, segment list reversed to stay in top-strand order) and sticky ends (left/right swap; a left 5' overhang becomes a right 5' overhang)
  setTopology(rec, topology: Topology): SeqRecord
     // linear→circular: features unchanged, sticky ends dropped; circular→linear (opened at the origin): wrapping segments become two segments [s,L) and [0,e-L) in top-strand order (a 2-segment join). Document.
  concatRecords(parts: readonly SeqRecord[], options?: { topology?: Topology; name?: string }): SeqRecord   // joins sequences, shifts features; ends from the first part's left end and the last part's right end.
  Immutable CRUD helpers: addFeature(rec, feature), updateFeature(rec, id, patch), removeFeature(rec, id), addPrimer, updatePrimer, removePrimer.
  remapFeatures(features, edit, oldLength, topology): export the pure remapping core so the UI can preview edits.

TESTS (the most important part):
- Hand-written cases for each rule on linear and circular records, including segments touching the edit boundaries, insertion at 0 and at L, wrapping segments, multi-segment features, zero-length (between-base) segments, minus-strand features, deletions that wrap the origin, deletions removing whole features, replacement inside a feature.
- Property tests with a seeded PRNG (≥ 2000 random cases per operation; random sequences of 1–300 bp; random features incl. wrapping and multi-segment): (a) every feature not touched by the edit has an identical featureSequence before and after; (b) rotateOrigin, reverseComplementRecord and concatRecords preserve featureSequence of every feature exactly; (c) extractRange preserves featureSequence of fully contained features; (d) every output range satisfies the normalized-range invariants of types.ts; (e) inputs are never mutated; (f) rotating by k and then by L-k is the identity (modulo ids).
