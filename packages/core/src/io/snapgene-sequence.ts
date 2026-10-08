/**
 * The DNA packet (0x00) and the sequence-properties packet (0x08) of SnapGene files:
 * bases, topology, strandedness / methylation flags, sticky ends and end modifications.
 *
 * DNA packet layout: 1 flags byte, then one ASCII byte per base. Flags (bit mask):
 *   0x01 circular, 0x02 double-stranded, 0x04 Dam-methylated, 0x08 Dcm-methylated,
 *   0x10 EcoKI-methylated.
 * Sources: Biopython SnapGeneIO (0x01); sgffp format spec and autosnapgene `DnaBlock`
 * (0x02-0x10); confirmed on the fixtures (e.g. 0x1f in pFA-KanMX4.dna, 0x02 in sample-d.dna).
 *
 * Sticky ends (`<AdditionalSequenceProperties>`): `UpstreamStickiness` / `DownstreamStickiness`
 * hold the number of single-stranded bases at the left / right end of a linear molecule,
 * POSITIVE for a 5' overhang and NEGATIVE for a 3' overhang. SnapGene's sequence spans both
 * strands, so the overhanging bases are part of it - the same convention as `FragmentEnds`
 * in types.ts, which therefore maps one-to-one:
 *   Upstream  +n -> left  { kind: '5prime', length: n }   (top strand's 5' end protrudes)
 *   Upstream  -n -> left  { kind: '3prime', length: n }   (bottom strand's 3' end protrudes)
 *   Downstream +n -> right { kind: '5prime', length: n }  (bottom strand's 5' end protrudes)
 *   Downstream -n -> right { kind: '3prime', length: n }  (top strand's 3' end protrudes)
 * Source of the sign convention: PlasmidPop's SnapGene reader (BooneAndrewsLab/PlasmidPop,
 * src/io/snapgene/parseSnapGene.ts), established on the 203 files bundled with SnapGene 8.2:
 * every linearised TA vector (3'-T overhangs) is -1/-1 and pET151/D-TOPO (5'-GTGG overhang
 * on the downstream end) is 0/4. None of the HHereditas fixtures has a non-zero value, so the
 * mapping is covered by round-trip and Biopython-independent synthetic tests only.
 */
import { IUPAC_DNA } from '../seq/alphabet';
import type { DnaEnd, FragmentEnds, SeqRecord, Topology } from '../types';
import type { ParseWarning } from './types';
import { childElements, escapeXmlText, plainToRichText, richTextToPlain, type XmlElement } from './snapgene-markup';
import { clip, listCharacters } from './snapgene-messages';

/** Bits of the DNA packet's flags byte (see the file comment for sources). */
export const DnaFlag = {
  Circular: 0x01,
  DoubleStranded: 0x02,
  Dam: 0x04,
  Dcm: 0x08,
  EcoKI: 0x10,
} as const;

/**
 * Keys of `meta.extras` written by the SnapGene reader for information the shared data model
 * does not represent, and read back by the writer.
 */
export const SnapGeneExtraKey = {
  /** 'double' or 'single' (DNA flag 0x02). */
  Strandedness: 'Strandedness',
  /** '1' or '0' (DNA flag 0x04). */
  DamMethylated: 'DamMethylated',
  /** '1' or '0' (DNA flag 0x08). */
  DcmMethylated: 'DcmMethylated',
  /** '1' or '0' (DNA flag 0x10). */
  EcoKIMethylated: 'EcoKIMethylated',
  /** Chemistry of the left end, e.g. 'Unmodified' or 'FivePrimePhosphorylated'. */
  UpstreamModification: 'UpstreamModification',
  /** Chemistry of the right end, e.g. 'Unmodified' or 'FivePrimePhosphorylated'. */
  DownstreamModification: 'DownstreamModification',
} as const;

const METHYLATION_FLAGS: ReadonlyArray<readonly [string, number]> = [
  [SnapGeneExtraKey.DamMethylated, DnaFlag.Dam],
  [SnapGeneExtraKey.DcmMethylated, DnaFlag.Dcm],
  [SnapGeneExtraKey.EcoKIMethylated, DnaFlag.EcoKI],
];

/**
 * Byte -> uppercase IUPAC character code (0 = not a nucleotide code). Lowercase is accepted
 * and RNA 'U'/'u' becomes 'T' (types.ts conventions).
 */
const BASE_CODE: Uint8Array = (() => {
  const table = new Uint8Array(256);
  for (const base of Object.keys(IUPAC_DNA)) {
    table[base.charCodeAt(0)] = base.charCodeAt(0);
    table[base.toLowerCase().charCodeAt(0)] = base.charCodeAt(0);
  }
  table['U'.charCodeAt(0)] = 'T'.charCodeAt(0);
  table['u'.charCodeAt(0)] = 'T'.charCodeAt(0);
  return table;
})();

const N_CODE = 'N'.charCodeAt(0);
const CHUNK = 8192;

/** String from 1-byte character codes (chunked to keep `fromCharCode`'s argument count small). */
function latin1ToString(codes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, codes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return parts.join('');
}

/** Contents of a DNA packet. */
export interface DnaPacketContent {
  /** Uppercase IUPAC sequence; same length as in the file (invalid bytes become 'N'). */
  seq: string;
  topology: Topology;
  /** Strandedness and methylation flags, under the {@link SnapGeneExtraKey} names. */
  extras: Record<string, string>;
}

/**
 * Read a DNA packet: the flags byte, then the bases. Bases are upper-cased and 'U' becomes 'T';
 * a byte that is not an IUPAC nucleotide code becomes 'N' (never dropped, so feature
 * coordinates stay valid) and is reported. Returns undefined for an empty payload.
 */
export function parseDnaPacket(payload: Uint8Array, warnings: ParseWarning[]): DnaPacketContent | undefined {
  if (payload.length === 0) return undefined;
  const flags = payload[0];
  const codes = new Uint8Array(payload.length - 1);
  const invalid = new Set<string>();
  let invalidCount = 0;
  for (let i = 1; i < payload.length; i++) {
    const code = BASE_CODE[payload[i]];
    if (code === 0) {
      invalidCount++;
      if (invalid.size <= 10) invalid.add(payload[i] < 0x80 ? String.fromCharCode(payload[i]) : `0x${payload[i].toString(16)}`);
      codes[i - 1] = N_CODE;
    } else {
      codes[i - 1] = code;
    }
  }
  if (invalidCount > 0) {
    warnings.push({
      message: `The DNA sequence contains ${invalidCount} character(s) that are not IUPAC nucleotide codes (${listCharacters(invalid)}); they were replaced by 'N' so that positions are preserved.`,
    });
  }
  const extras: Record<string, string> = {
    [SnapGeneExtraKey.Strandedness]: flags & DnaFlag.DoubleStranded ? 'double' : 'single',
  };
  for (const [key, bit] of METHYLATION_FLAGS) extras[key] = flags & bit ? '1' : '0';
  return { seq: latin1ToString(codes), topology: flags & DnaFlag.Circular ? 'circular' : 'linear', extras };
}

/**
 * Encode a DNA packet. Strandedness and methylation come from `extras` (defaults: double
 * stranded, not methylated). Characters that are not IUPAC nucleotide codes are written as
 * 'N' (with a warning) so that the length - and every feature coordinate - is unchanged.
 */
export function encodeDnaPacket(seq: string, topology: Topology, extras: Readonly<Record<string, string>> | undefined, warnings: ParseWarning[]): Uint8Array {
  let flags = topology === 'circular' ? DnaFlag.Circular : 0;
  if (extras?.[SnapGeneExtraKey.Strandedness] !== 'single') flags |= DnaFlag.DoubleStranded;
  for (const [key, bit] of METHYLATION_FLAGS) if (extras?.[key] === '1') flags |= bit;
  const out = new Uint8Array(seq.length + 1);
  out[0] = flags;
  const invalid = new Set<string>();
  let invalidCount = 0;
  for (let i = 0; i < seq.length; i++) {
    const c = seq.charCodeAt(i);
    const code = c < 256 ? BASE_CODE[c] : 0;
    if (code === 0) {
      invalidCount++;
      if (invalid.size <= 10) invalid.add(seq[i]);
      out[i + 1] = N_CODE;
    } else {
      out[i + 1] = code;
    }
  }
  if (invalidCount > 0) {
    warnings.push({
      message: `The sequence contains ${invalidCount} character(s) that are not IUPAC nucleotide codes (${listCharacters(invalid)}); they were written as 'N'.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// <AdditionalSequenceProperties>
// ---------------------------------------------------------------------------

/** What the sequence-properties packet contributes to a record. */
export interface SequenceProperties {
  ends?: FragmentEnds;
  /** End modifications, under the {@link SnapGeneExtraKey} names. */
  extras: Record<string, string>;
}

const BLUNT: DnaEnd = { kind: 'blunt', length: 0 };

function endFromStickiness(stickiness: number): DnaEnd {
  if (stickiness === 0) return { ...BLUNT };
  return { kind: stickiness > 0 ? '5prime' : '3prime', length: Math.abs(stickiness) };
}

/** Signed SnapGene stickiness of an end (positive = 5' overhang, negative = 3' overhang). */
function stickinessFromEnd(end: DnaEnd): number {
  if (end.kind === 'blunt' || end.length === 0) return 0;
  return end.kind === '5prime' ? end.length : -end.length;
}

function childText(root: XmlElement, name: string): string | undefined {
  const el = childElements(root, name)[0];
  return el === undefined ? undefined : el.text;
}

/** Parse a stickiness value; 0 (blunt) when absent, and 0 with a warning when it is not an integer. */
function readStickiness(root: XmlElement, name: string, warnings: ParseWarning[]): number {
  const text = childText(root, name);
  if (text === undefined || text.trim() === '') return 0;
  if (!/^[+-]?\d+$/.test(text.trim())) {
    warnings.push({ message: `Ignored the sequence property ${name}="${clip(text.trim())}": not an integer.` });
    return 0;
  }
  return Number.parseInt(text.trim(), 10);
}

/**
 * Read `<AdditionalSequenceProperties>`: sticky ends (linear molecules only; checked against
 * the sequence length) and end modifications.
 */
export function parseSequenceProperties(root: XmlElement, seqLength: number, topology: Topology, warnings: ParseWarning[]): SequenceProperties {
  const extras: Record<string, string> = {};
  for (const key of [SnapGeneExtraKey.UpstreamModification, SnapGeneExtraKey.DownstreamModification]) {
    const text = childText(root, key);
    if (text !== undefined && text.trim() !== '') extras[key] = richTextToPlain(text, 'line');
  }
  const upstream = readStickiness(root, 'UpstreamStickiness', warnings);
  const downstream = readStickiness(root, 'DownstreamStickiness', warnings);
  if (upstream === 0 && downstream === 0) return { extras };
  if (topology === 'circular') {
    warnings.push({ message: `Ignored sticky ends (UpstreamStickiness=${upstream}, DownstreamStickiness=${downstream}) on a circular sequence.` });
    return { extras };
  }
  if (Math.abs(upstream) + Math.abs(downstream) >= seqLength) {
    warnings.push({
      message: `Ignored sticky ends (UpstreamStickiness=${upstream}, DownstreamStickiness=${downstream}): together they cover the whole ${seqLength} bp sequence, leaving no double-stranded part.`,
    });
    return { extras };
  }
  return { ends: { left: endFromStickiness(upstream), right: endFromStickiness(downstream) }, extras };
}

function isValidEnd(end: DnaEnd | undefined): end is DnaEnd {
  if (end === undefined || end === null || typeof end !== 'object') return false;
  if (!Number.isInteger(end.length) || end.length < 0) return false;
  if (end.kind === 'blunt') return end.length === 0;
  return end.kind === '5prime' || end.kind === '3prime';
}

/**
 * Build the `<AdditionalSequenceProperties>` packet payload text for a record. Sticky ends
 * are written only for linear records whose ends are well-formed and leave a double-stranded
 * part; anything else is written as blunt, with a warning.
 */
export function buildSequencePropertiesXml(record: SeqRecord, warnings: ParseWarning[]): string {
  let upstream = 0;
  let downstream = 0;
  const ends = record.ends;
  if (ends !== undefined) {
    if (record.topology === 'circular') {
      if (stickinessFromEndSafe(ends.left) !== 0 || stickinessFromEndSafe(ends.right) !== 0) {
        warnings.push({ message: 'The record is circular, so its sticky ends were not written (SnapGene stores ends for linear sequences only).' });
      }
    } else if (!isValidEnd(ends.left) || !isValidEnd(ends.right)) {
      warnings.push({ message: 'The record has malformed sticky ends; they were written as blunt.' });
    } else {
      const up = stickinessFromEnd(ends.left);
      const down = stickinessFromEnd(ends.right);
      if (Math.abs(up) + Math.abs(down) >= record.seq.length && (up !== 0 || down !== 0)) {
        warnings.push({ message: `The sticky ends (${ends.left.length} + ${ends.right.length} nt) cover the whole ${record.seq.length} bp sequence; they were written as blunt.` });
      } else {
        upstream = up;
        downstream = down;
      }
    }
  }
  const modification = (key: string) => {
    const value = record.meta.extras?.[key];
    return escapeXmlText(plainToRichText(value !== undefined && value.trim() !== '' ? value : 'Unmodified'));
  };
  return (
    '<AdditionalSequenceProperties>' +
    `<UpstreamStickiness>${upstream}</UpstreamStickiness>` +
    `<DownstreamStickiness>${downstream}</DownstreamStickiness>` +
    `<UpstreamModification>${modification(SnapGeneExtraKey.UpstreamModification)}</UpstreamModification>` +
    `<DownstreamModification>${modification(SnapGeneExtraKey.DownstreamModification)}</DownstreamModification>` +
    '</AdditionalSequenceProperties>'
  );
}

/** Stickiness of a possibly malformed end (0 when malformed); used only to decide whether to warn. */
function stickinessFromEndSafe(end: DnaEnd | undefined): number {
  return isValidEnd(end) ? stickinessFromEnd(end) : 0;
}
