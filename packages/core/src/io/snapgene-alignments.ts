/**
 * SnapGene reference-sequence alignments (`Align with:` / Aligned Sequences):
 *
 * Reconstructed from `SnapGene.exe` (`0x142485905..0x14248e8e6` and `0x140848661..0x1408492e7`):
 *  - Packet `0x11` (`<AlignableSequences trimStringency="...">`):
 *      `<Sequence ID="0" name="..." isTrace="1" use="1" sortOrder="0" trimmedRange="2..989" manuallyTrimmed="1"/>`
 *  - Packet `0x10` (Embedded alignable sequence / trace container):
 *      `[4-byte big-endian sequence ID][nested SnapGene packets: 0x00 DNA or 0x12 ZTR trace]`
 *  - Packet `0x1B` (BGZF-compressed BAM alignment container):
 *      Concatenated RFC 1952 / BGZF blocks (`1f 8b` with `BC` subfield) decompressing to a
 *      `BAM\x01` binary alignment stream whose `read_name` matches `<Sequence ID="...">`.
 *
 * Also provides:
 *  - Pure-TypeScript `.scf` (Standard Chromatogram Format v2/v3) and `.ab1` (ABI ABIF) base-call extraction
 *  - Pure-TypeScript reference alignment engine (`alignSequenceToReference`) for aligning any imported
 *    DNA sequence, open document, pasted read, or Sanger chromatogram against a linear or circular reference.
 */
import { reverseComplement } from '../seq/alphabet';
import { parseChromatogram, type TraceReadData } from './chromatogram';
import { inflateRaw } from './inflate';
import { alignSangerRead } from './sanger-aligner';
import type { AlignedSequence, ChromatogramTrace, Range, Topology } from '../types';
import { SnapGenePacketType, encodePackets, encodeUtf8, readPackets, type SnapGenePacket } from './snapgene-binary';
import type { XmlElement } from './snapgene-markup';

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// BGZF (1f 8b) decompression (DEFLATE itself is in ./inflate)
// ---------------------------------------------------------------------------

/** Decompress a multi-member GZIP / BGZF (`1f 8b`) buffer (such as SnapGene Packet `0x1B`). */
export function decompressBgzf(payload: Uint8Array): Uint8Array | null {
  try {
    const chunks: Uint8Array[] = [];
    let pos = 0;
    while (pos + 18 <= payload.length) {
      if (payload[pos] !== 0x1f || payload[pos + 1] !== 0x8b || payload[pos + 2] !== 0x08) break;
      const flg = payload[pos + 3];
      let p = pos + 10;
      let bsize = 0;
      if (flg & 0x04) {
        if (p + 2 > payload.length) break;
        const xlen = payload[p] | (payload[p + 1] << 8);
        p += 2;
        const xend = p + xlen;
        let xp = p;
        while (xp + 4 <= xend && xp + 4 <= payload.length) {
          const si1 = payload[xp];
          const si2 = payload[xp + 1];
          const slen = payload[xp + 2] | (payload[xp + 3] << 8);
          if (si1 === 0x42 && si2 === 0x43 && slen === 2 && xp + 6 <= payload.length) {
            bsize = (payload[xp + 4] | (payload[xp + 5] << 8)) + 1;
          }
          xp += 4 + slen;
        }
        p = xend;
      }
      if (flg & 0x08) {
        while (p < payload.length && payload[p] !== 0) p++;
        p++;
      }
      if (flg & 0x10) {
        while (p < payload.length && payload[p] !== 0) p++;
        p++;
      }
      if (flg & 0x02) p += 2;
      if (p > payload.length) break;

      const { output, bytesRead } = inflateRaw(payload, p);
      if (output.length > 0) chunks.push(output);
      if (bsize > 0 && pos + bsize <= payload.length) {
        pos += bsize;
      } else {
        pos = p + bytesRead + 8;
      }
    }
    if (chunks.length === 0) return null;
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return merged;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// BAM (Packet 0x1B) parser
// ---------------------------------------------------------------------------

const BAM_CIGAR_OPS = 'MIDNSHP=X';
const BAM_SEQ_CHARS = '=ACMGRSVTWYHKDBN';

export interface BamAlignmentRecord {
  readName: string;
  refId: number;
  pos: number;
  flag: number;
  strand: 1 | -1;
  cigarOps: Array<{ op: string; len: number }>;
  cigar: string;
  /** Read sequence stored in BAM (in reference top-strand orientation when aligned). */
  seq: string;
}

function readInt32LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
}

function readUint16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function readUint32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function parseBamBytes(bam: Uint8Array): BamAlignmentRecord[] {
  if (bam.length < 12) return [];
  if (bam[0] !== 0x42 || bam[1] !== 0x41 || bam[2] !== 0x4d || bam[3] !== 0x01) return [];
  let p = 4;
  const lText = readInt32LE(bam, p);
  p += 4 + Math.max(0, lText);
  if (p + 4 > bam.length) return [];
  const nRef = readInt32LE(bam, p);
  p += 4;
  for (let i = 0; i < nRef; i++) {
    if (p + 4 > bam.length) return [];
    const lName = readInt32LE(bam, p);
    p += 4 + Math.max(0, lName) + 4;
  }

  const out: BamAlignmentRecord[] = [];
  while (p + 4 <= bam.length) {
    const blockSize = readInt32LE(bam, p);
    p += 4;
    if (blockSize <= 0 || p + blockSize > bam.length) break;
    const rec = bam.subarray(p, p + blockSize);
    p += blockSize;
    if (rec.length < 32) continue;

    const refId = readInt32LE(rec, 0);
    const pos = readInt32LE(rec, 4);
    const lReadName = rec[8];
    const nCigarOp = readUint16LE(rec, 12);
    const flag = readUint16LE(rec, 14);
    const lSeq = readInt32LE(rec, 16);
    if (32 + lReadName > rec.length) continue;

    let readName = '';
    for (let i = 0; i < lReadName - 1; i++) {
      const ch = rec[32 + i];
      if (ch === 0) break;
      readName += String.fromCharCode(ch);
    }

    let cp = 32 + lReadName;
    if (cp + nCigarOp * 4 > rec.length) continue;
    const cigarOps: Array<{ op: string; len: number }> = [];
    for (let k = 0; k < nCigarOp; k++) {
      const v = readUint32LE(rec, cp);
      cp += 4;
      cigarOps.push({ op: BAM_CIGAR_OPS[v & 0x0f] ?? 'M', len: v >>> 4 });
    }

    const seqBytes = (lSeq + 1) >> 1;
    if (cp + seqBytes > rec.length) continue;
    let seq = '';
    for (let i = 0; i < lSeq; i++) {
      const byte = rec[cp + (i >> 1)];
      const code = (i & 1) === 0 ? byte >>> 4 : byte & 0x0f;
      seq += BAM_SEQ_CHARS[code] ?? 'N';
    }

    out.push({
      readName,
      refId,
      pos,
      flag,
      strand: (flag & 0x10) !== 0 ? -1 : 1,
      cigarOps,
      cigar: cigarOps.map((c) => `${c.len}${c.op}`).join(''),
      seq,
    });
  }
  return out;
}

/**
 * Project a BAM alignment record onto the reference DNA sequence to compute `refRange`,
 * `alignedBases`, `mismatches`, `leftTail`, `rightTail`, and `identity`.
 */
function projectBamAlignment(
  bam: BamAlignmentRecord,
  refSeq: string,
): {
  aligned: boolean;
  refRange: Range;
  leftTail: number;
  rightTail: number;
  mismatches: number[];
  alignedBases: string;
  identity: number;
} {
  const L = refSeq.length;
  if ((bam.flag & 0x04) !== 0 || bam.pos < 0 || L === 0 || bam.cigarOps.length === 0) {
    return {
      aligned: false,
      refRange: { start: 0, end: 0 },
      leftTail: 0,
      rightTail: 0,
      mismatches: [],
      alignedBases: '',
      identity: 0,
    };
  }

  let leftTail = 0;
  let rightTail = 0;
  let refPos = bam.pos;
  let readPos = 0;
  let alignedBases = '';
  const mismatchSet = new Set<number>();
  let matches = 0;
  let totalAlignedCols = 0;

  for (let idx = 0; idx < bam.cigarOps.length; idx++) {
    const { op, len } = bam.cigarOps[idx];
    if (op === 'S' || op === 'H') {
      if (idx === 0) leftTail += len;
      else if (idx === bam.cigarOps.length - 1) rightTail += len;
      if (op === 'S') readPos += len;
    } else if (op === 'M' || op === '=' || op === 'X') {
      for (let k = 0; k < len; k++) {
        const rp = (refPos + k) % L;
        const rBase = refSeq[rp] ?? 'N';
        const qBase = bam.seq[readPos + k] ?? 'N';
        alignedBases += qBase;
        totalAlignedCols++;
        if (qBase === rBase && qBase !== 'N') {
          matches++;
        } else {
          mismatchSet.add(rp);
        }
      }
      refPos += len;
      readPos += len;
    } else if (op === 'I') {
      mismatchSet.add(refPos % L);
      totalAlignedCols += len;
      readPos += len;
    } else if (op === 'D' || op === 'N') {
      for (let k = 0; k < len; k++) {
        const rp = (refPos + k) % L;
        alignedBases += '-';
        mismatchSet.add(rp);
        totalAlignedCols++;
      }
      refPos += len;
    }
  }

  const identity = totalAlignedCols > 0 ? Math.round((matches / totalAlignedCols) * 1000) / 10 : 0;
  return {
    aligned: refPos > bam.pos,
    refRange: { start: bam.pos, end: refPos },
    leftTail,
    rightTail,
    mismatches: [...mismatchSet].sort((a, b) => a - b),
    alignedBases,
    identity,
  };
}

// ---------------------------------------------------------------------------
// Sanger Chromatogram (.scf / .ab1) and ZTR base-call extraction
// ---------------------------------------------------------------------------

function readUint32BE(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/**
 * Extract called DNA bases from a Standard Chromatogram Format (`.scf`) or ABI ABIF (`.ab1`) file.
 * Returns null if `data` is not a recognized chromatogram format.
 */
export function parseTraceFileBases(data: Uint8Array): string | null {
  return parseTraceFile(data)?.bases ?? null;
}

/**
 * Extract called bases, Phred qualities, signal channels and peak positions from a `.scf`, `.ab1` or ZTR file.
 * Returns null if `data` is not a recognized chromatogram format.
 */
export function parseTraceFile(data: Uint8Array): TraceReadData | null {
  const r = parseChromatogram(data);
  return r && r.bases.length > 0 ? r : null;
}

// ---------------------------------------------------------------------------
// Reference Alignment Engine (`alignSequenceToReference`)
// ---------------------------------------------------------------------------

export interface AlignSequenceInput {
  id?: string;
  name: string;
  sequence: string;
  /** Phred quality per base of `sequence` (chromatogram reads); used in scoring and kept on the result. */
  quality?: number[];
  /** Chromatogram of the read (kept on the result for display). */
  trace?: ChromatogramTrace;
  runDate?: string;
  isTrace?: boolean;
  sortOrder?: number;
  visible?: boolean;
  trimmedRange?: Range;
  manuallyTrimmed?: boolean;
}

/**
 * Per-base Phred values handed to the aligner: the read's own qualities (Q30 for every base when it has none), with
 * the bases outside `trimmedRange` lowered to Q5 so the aligner treats them as unreliable ends.
 */
function alignmentQualities(qLen: number, quality: number[] | undefined, trimmed: Range | undefined): number[] | undefined {
  const own = quality && quality.length === qLen ? quality : undefined;
  if (!trimmed) return own;
  const out: number[] = [];
  for (let i = 0; i < qLen; i++) {
    const q = own ? own[i] : 40;
    out.push(i >= trimmed.start && i < trimmed.end ? q : Math.min(q, 5));
  }
  return out;
}

/**
 * Align a query DNA sequence (or Sanger trace read) to a reference sequence on both
 * forward (+1) and reverse (-1) strands, handling circular origin wrap-around automatically.
 * The aligner (./sanger-aligner) reports any significant match, also when only part of the read is on the
 * reference, and keeps a deleted or inserted stretch of any size inside one alignment.
 */
export function alignSequenceToReference(
  referenceSeq: string,
  topology: Topology,
  input: AlignSequenceInput,
): AlignedSequence {
  const ref = referenceSeq.toUpperCase();
  const L = ref.length;
  const rawQuery = input.sequence.toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, '');
  const qLen = rawQuery.length;
  const givenTrim =
    input.trimmedRange && input.trimmedRange.end > input.trimmedRange.start
      ? {
          start: Math.max(0, Math.min(qLen, input.trimmedRange.start)),
          end: Math.max(0, Math.min(qLen, input.trimmedRange.end)),
        }
      : undefined;
  const trimmedRange = givenTrim ?? { start: 0, end: qLen };
  const id = input.id ?? `aln_${Math.random().toString(36).slice(2, 8)}`;
  const base = {
    id,
    name: input.name,
    sequence: rawQuery,
    isTrace: input.isTrace,
    sortOrder: input.sortOrder ?? 0,
    visible: input.visible ?? true,
    trimmedRange,
    manuallyTrimmed: input.manuallyTrimmed,
    // per-base data belongs to the read only when no letter was dropped above
    ...(input.quality?.length === qLen ? { quality: input.quality } : {}),
    ...(input.trace?.peaks.length === qLen ? { trace: input.trace } : {}),
    ...(input.runDate ? { runDate: input.runDate } : {}),
  };
  const unaligned: AlignedSequence = {
    ...base,
    aligned: false,
    strand: 1,
    refRange: { start: 0, end: 0 },
    leftTail: trimmedRange.start,
    rightTail: qLen - trimmedRange.end,
    cigar: qLen ? `${qLen}S` : '',
    mismatches: [],
    alignedBases: '',
    identity: 0,
  };
  if (L === 0 || qLen === 0) return unaligned;

  // the quality of a base whose letter was dropped above cannot be matched to it any more: keep qualities only when
  // the read had nothing to drop
  const quality = input.quality && input.quality.length === qLen ? input.quality : undefined;
  const r = alignSangerRead(ref, topology === 'circular', {
    seq: rawQuery,
    qual: alignmentQualities(qLen, quality, givenTrim),
  });
  if (!r.aligned) return unaligned;

  const cigarOps: Array<{ op: string; len: number }> = [];
  for (const m of r.cigar.matchAll(/(\d+)([MIDS])/g)) cigarOps.push({ op: m[2], len: Number(m[1]) });
  const proj = projectBamAlignment(
    {
      readName: id,
      refId: 0,
      pos: r.refStart,
      flag: r.strand === 1 ? 0 : 0x10,
      strand: r.strand,
      cigarOps,
      cigar: r.cigar,
      seq: r.strand === 1 ? rawQuery : reverseComplement(rawQuery),
    },
    ref,
  );
  if (!proj.aligned) return unaligned;
  return {
    ...base,
    aligned: true,
    strand: r.strand,
    refRange: proj.refRange,
    leftTail: proj.leftTail,
    rightTail: proj.rightTail,
    cigar: r.cigar,
    mismatches: proj.mismatches,
    alignedBases: proj.alignedBases,
    identity: proj.identity,
  };
}

// ---------------------------------------------------------------------------
// SnapGene Packet 0x10 + Packet 0x11 (<AlignableSequences>) + Packet 0x1B reader/writer
// ---------------------------------------------------------------------------

interface AlignableSeqMeta {
  id: string;
  name: string;
  isTrace: boolean;
  visible: boolean;
  sortOrder: number;
  manuallyTrimmed: boolean;
  trimmedRange?: Range;
}

function parseTrimmedRangeAttr(raw: string | undefined): Range | undefined {
  if (!raw) return undefined;
  const m = /^(\d+)\.\.(\d+)$/.exec(raw.trim());
  if (!m) return undefined;
  const start1 = Number.parseInt(m[1], 10);
  const end1 = Number.parseInt(m[2], 10);
  if (Number.isNaN(start1) || Number.isNaN(end1) || start1 < 1 || end1 < start1) return undefined;
  return { start: start1 - 1, end: end1 };
}

export function parseAlignableSequencesElement(root: XmlElement): AlignableSeqMeta[] {
  const metas: AlignableSeqMeta[] = [];
  for (const child of root.children) {
    if (child.name !== 'Sequence') continue;
    const id = child.attributes.get('ID') ?? String(metas.length);
    const name = (child.attributes.get('name') ?? `Sequence ${metas.length + 1}`).trim() || `Sequence ${metas.length + 1}`;
    const isTrace = child.attributes.get('isTrace') === '1';
    const visible = child.attributes.get('use') !== '0';
    const sortOrder = Number.parseInt(child.attributes.get('sortOrder') ?? String(metas.length), 10);
    const manuallyTrimmed = child.attributes.get('manuallyTrimmed') === '1';
    const trimmedRange = parseTrimmedRangeAttr(child.attributes.get('trimmedRange'));
    metas.push({
      id,
      name,
      isTrace,
      visible,
      sortOrder: Number.isNaN(sortOrder) ? metas.length : sortOrder,
      manuallyTrimmed,
      trimmedRange,
    });
  }
  return metas;
}

/** Extract the read from a Packet `0x10` payload (`[4-byte BE ID][sub-packets]`): plain DNA, or a ZTR chromatogram. */
function parseEmbeddedAlignablePacket(payload: Uint8Array): EmbeddedRead | null {
  if (payload.length < 5) return null;
  const id = String(readUint32BE(payload, 0));
  const scan = readPackets(payload.subarray(4));
  for (const sub of scan.packets) {
    if (sub.type === SnapGenePacketType.Dna && sub.payload.length >= 1) {
      let seq = '';
      for (let i = 1; i < sub.payload.length; i++) {
        const ch = String.fromCharCode(sub.payload[i]).toUpperCase();
        if (/[ACGTRYSWKMBDHVN]/.test(ch)) seq += ch;
      }
      return { id, seq, isTrace: false };
    }
    if (sub.type === 0x12) {
      // ZTR chromatogram packet; the BAM record (Packet 0x1B) holds the same bases
      const ztr = parseChromatogram(sub.payload);
      return { id, seq: ztr?.bases ?? '', isTrace: true, quality: ztr?.quality, trace: ztr?.trace, runDate: ztr?.runDate };
    }
  }
  return null;
}

interface EmbeddedRead {
  id: string;
  seq: string;
  isTrace: boolean;
  quality?: number[];
  trace?: ChromatogramTrace;
  runDate?: string;
}

/** Quality, trace and run date of an embedded read, when they belong to `seq` (same number of bases). */
function traceExtras(emb: EmbeddedRead | undefined, seq: string): Pick<AlignedSequence, 'quality' | 'trace' | 'runDate'> {
  if (!emb || emb.seq.length !== seq.length) return {};
  const out: Pick<AlignedSequence, 'quality' | 'trace' | 'runDate'> = {};
  if (emb.quality) out.quality = emb.quality;
  if (emb.trace) out.trace = emb.trace;
  if (emb.runDate) out.runDate = emb.runDate;
  return out;
}

/**
 * Reconstruct all `AlignedSequence` items from a `.dna` packet scan (`0x10`, `0x11`, and `0x1B`).
 */
export function parseSnapGeneAlignments(
  packets: readonly SnapGenePacket[],
  alignableRoots: readonly XmlElement[],
  refSeq: string,
  topology: Topology,
): AlignedSequence[] {
  const metas: AlignableSeqMeta[] = [];
  for (const root of alignableRoots) {
    for (const m of parseAlignableSequencesElement(root)) metas.push(m);
  }
  if (metas.length === 0) return [];

  const embeddedById = new Map<string, EmbeddedRead>();
  const bamById = new Map<string, BamAlignmentRecord>();

  for (const pkt of packets) {
    if (pkt.type === 0x10) {
      const emb = parseEmbeddedAlignablePacket(pkt.payload);
      if (emb) embeddedById.set(emb.id, emb);
    } else if (pkt.type === 0x1b) {
      const decompressed = decompressBgzf(pkt.payload);
      if (decompressed) {
        for (const rec of parseBamBytes(decompressed)) {
          bamById.set(rec.readName, rec);
        }
      }
    }
  }

  const out: AlignedSequence[] = [];
  for (const meta of metas) {
    const emb = embeddedById.get(meta.id);
    const bam = bamById.get(meta.id);
    if (bam) {
      const proj = projectBamAlignment(bam, refSeq);
      // In BAM, if strand === -1, bam.seq is reverse-complemented into top-strand orientation;
      // the original 5'->3' query sequence is therefore reverseComplement(bam.seq).
      const querySeq = emb?.seq || (bam.strand === -1 ? reverseComplement(bam.seq) : bam.seq);
      out.push({
        id: meta.id,
        name: meta.name,
        sequence: querySeq,
        isTrace: meta.isTrace || emb?.isTrace,
        sortOrder: meta.sortOrder,
        visible: meta.visible,
        trimmedRange: meta.trimmedRange,
        manuallyTrimmed: meta.manuallyTrimmed,
        aligned: proj.aligned,
        strand: bam.strand,
        refRange: proj.refRange,
        leftTail: proj.leftTail,
        rightTail: proj.rightTail,
        cigar: bam.cigar,
        mismatches: proj.mismatches,
        alignedBases: proj.alignedBases,
        identity: proj.identity,
        ...traceExtras(emb, querySeq),
      });
    } else if (emb?.seq) {
      out.push(
        alignSequenceToReference(refSeq, topology, {
          id: meta.id,
          name: meta.name,
          sequence: emb.seq,
          quality: emb.quality,
          trace: emb.trace,
          runDate: emb.runDate,
          isTrace: meta.isTrace || emb.isTrace,
          sortOrder: meta.sortOrder,
          visible: meta.visible,
          trimmedRange: meta.trimmedRange,
          manuallyTrimmed: meta.manuallyTrimmed,
        }),
      );
    }
  }

  out.sort((a, b) => a.sortOrder - b.sortOrder);
  return out;
}

/** Build `<AlignableSequences>` XML (Packet `0x11`) and Packet `0x10` payloads for `.dna` export. */
export function buildAlignedSequencePackets(
  alignedSequences: readonly AlignedSequence[] | undefined,
): Array<{ type: number; payload: Uint8Array }> {
  if (!alignedSequences || alignedSequences.length === 0) {
    return [
      {
        type: SnapGenePacketType.AlignableSequences,
        payload: encodeUtf8('<AlignableSequences trimStringency="Medium"/>'),
      },
    ];
  }

  const packets: Array<{ type: number; payload: Uint8Array }> = [];
  const xmlEntries: string[] = [];

  alignedSequences.forEach((item, idx) => {
    const numId = Number.isInteger(Number(item.id)) && Number(item.id) >= 0 ? Number(item.id) : idx;
    if (item.sequence.length > 0) {
      const dnaPayload = new Uint8Array(1 + item.sequence.length);
      dnaPayload[0] = 0x02; // linear double-stranded
      for (let i = 0; i < item.sequence.length; i++) {
        dnaPayload[1 + i] = item.sequence.charCodeAt(i) & 0x7f;
      }
      const subPacket = encodePackets([{ type: SnapGenePacketType.Dna, payload: dnaPayload }]);
      const pkt10 = new Uint8Array(4 + subPacket.length);
      pkt10[0] = (numId >>> 24) & 0xff;
      pkt10[1] = (numId >>> 16) & 0xff;
      pkt10[2] = (numId >>> 8) & 0xff;
      pkt10[3] = numId & 0xff;
      pkt10.set(subPacket, 4);
      packets.push({ type: 0x10, payload: pkt10 });
    }

    const attrs: string[] = [
      `name="${escapeXmlAttr(item.name)}"`,
      `ID="${numId}"`,
      `isTrace="${item.isTrace ? 1 : 0}"`,
      `sortOrder="${item.sortOrder ?? idx}"`,
    ];
    if (!item.visible) attrs.push('use="0"');
    if (item.manuallyTrimmed) attrs.push('manuallyTrimmed="1"');
    if (item.trimmedRange && item.trimmedRange.end > item.trimmedRange.start) {
      attrs.push(`trimmedRange="${item.trimmedRange.start + 1}..${item.trimmedRange.end}"`);
    }
    xmlEntries.push(`<Sequence ${attrs.join(' ')}/>`);
  });

  packets.push({
    type: SnapGenePacketType.AlignableSequences,
    payload: encodeUtf8(`<AlignableSequences trimStringency="Medium">${xmlEntries.join('')}</AlignableSequences>`),
  });
  return packets;
}
