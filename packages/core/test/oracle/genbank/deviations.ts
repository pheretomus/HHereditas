/**
 * Deliberate differences between our GenBank reader and Biopython 1.88, per fixture.
 * Used by the static oracle test (our parse vs Biopython's parse of the fixture) and by the
 * live oracle test (Biopython's parse of writeGenbank output vs Biopython's parse of the fixture).
 */
import type { FeatureDeviation } from './compare';

/** A whole file that Biopython cannot read but we can. */
export interface FileDeviation {
  file: string;
  reason: string;
  /** Number of records we read from it. */
  records: number;
}

/** A record-level field where Biopython's value is an artefact of column-based parsing. */
export interface RecordDeviation {
  file: string;
  record: number;
  field: 'moleculeType';
  reason: string;
}

export const GENBANK_FILE_DEVIATIONS: FileDeviation[] = [
  {
    file: 'no_origin_no_end.gb',
    reason:
      'No ORIGIN and no // terminator: Biopython raises "Premature end of line during features table". ' +
      'We keep the header and features and use an N placeholder of the LOCUS length (with warnings).',
    records: 1,
  },
];

export const GENBANK_RECORD_DEVIATIONS: RecordDeviation[] = [
  {
    file: 'addgene-plasmid-39296-sequence-49545.gbk',
    record: 0,
    field: 'moleculeType',
    reason:
      'The 12-character locus name shifts the LOCUS columns; Biopython falls back to a token branch that ' +
      "does not record the molecule token and reports the category 'DNA'. Our token-based LOCUS reader keeps " +
      "'ds-DNA' as written (same DNA category).",
  },
];

const linearJoinReason =
  "Start > end on a LINEAR record: Biopython rejects the location (location None, 'it appears ... spans the " +
  "origin, but the sequence topology is undefined'). We keep the feature as join(start..L,1..end) with a " +
  'warning, so no annotated bases are lost and the record can be re-exported as valid GenBank.';

export const GENBANK_FEATURE_DEVIATIONS: FeatureDeviation[] = [
  {
    file: 'addgene-plasmid-11664-sequence-180430.gbk',
    record: 0,
    feature: 33, // enhancer 8569..276 on a linear 8596 bp record
    kind: 'location',
    reason: linearJoinReason,
    expected: {
      strand: 1,
      segments: [
        { start: 8568, end: 8596 },
        { start: 0, end: 276 },
      ],
      partialStart: false,
      partialEnd: false,
    },
  },
  {
    file: 'bad_origin_wrap_linear.gb',
    record: 0,
    feature: 1, // gene 6801..100 on a linear 7000 bp record
    kind: 'location',
    reason: linearJoinReason,
    expected: {
      strand: 1,
      segments: [
        { start: 6800, end: 7000 },
        { start: 0, end: 100 },
      ],
      partialStart: false,
      partialEnd: false,
    },
  },
  {
    file: 'negative_location.gb',
    record: 0,
    feature: 1, // CDS complement(-2..492)
    kind: 'location',
    reason:
      "Negative start position: Biopython rejects the location (None, 'negative starting position'). We clamp " +
      'the start to base 1 and mark the feature partial on that side, which is how INSDC writes a feature that ' +
      'extends beyond the sequence (<1..492).',
    expected: { strand: -1, segments: [{ start: 0, end: 492 }], partialStart: true, partialEnd: false },
  },
  {
    file: 'bad_origin_wrap.gb',
    record: 0,
    feature: 5, // CDS join(5400..5600,5700..6100,complement(<6801..100))
    kind: 'location',
    reason:
      'Mixed-strand join: Biopython keeps one strand per part; our Feature has a single strand, so the majority ' +
      "strand (+1, 2 of 3 parts) is used with a warning. The '<' on the inner part cannot be represented either " +
      '(warning). Covered bases are identical; the origin-spanning part is merged into one segment.',
    expected: {
      strand: 1,
      segments: [
        { start: 5399, end: 5600 },
        { start: 5699, end: 6100 },
        { start: 6800, end: 7100 },
      ],
      partialStart: false,
      partialEnd: false,
    },
  },
  {
    file: 'qualifier_escaping_read.gb',
    record: 0,
    feature: 4, // misc_feature 215902..365470 on a 182-residue protein
    kind: 'dropped',
    reason:
      'The location lies entirely beyond the end of the 182-residue sequence. Biopython keeps it as an ' +
      'out-of-range location; we drop the feature with a warning because it annotates no residue of this record.',
  },
];
