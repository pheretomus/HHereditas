/**
 * SnapGene container layer: packets, the cookie packet and UTF-8 text.
 *
 * A SnapGene file is a flat sequence of packets, each laid out as
 *
 *     [1-byte type][4-byte big-endian payload length][payload]
 *
 * and the first packet must be the 14-byte cookie (type 0x09): the ASCII text `SnapGene`
 * followed by three big-endian uint16 values (sequence type, export version, import version).
 *
 * Sources (the format is proprietary and undocumented by its vendor; everything here is
 * reverse-engineered and cross-checked against the fixtures in `test/fixtures/snapgene`):
 *  - Biopython `Bio/SeqIO/SnapGeneIO.py` (D. Goutte-Gattat, 2017-2019), the reference oracle.
 *  - D. Goutte-Gattat, "Binary sequence formats", https://incenp.org/dvlpt/docs/binary-sequence-formats/
 *  - sgffp format specification, https://merv1n34k.github.io/sgffp/format-spec.html
 *
 * Nothing in this file throws on malformed input: readers report problems as {@link ParseWarning}s.
 */
import type { ParseWarning } from './types';

/**
 * Packet type codes used by HHereditas (first byte of every packet).
 * Sources: Biopython SnapGeneIO (0x00, 0x05, 0x06, 0x09, 0x0A), sgffp format spec (all codes),
 * confirmed by dumping every fixture.
 */
export const SnapGenePacketType = {
  /** Uncompressed DNA: 1 flags byte, then the bases as ASCII. */
  Dna: 0x00,
  /** Compressed DNA (2-bit packed); used inside history snapshots, not read by HHereditas. */
  CompressedDna: 0x01,
  /** `<Primers>` XML. */
  Primers: 0x05,
  /** `<Notes>` XML (description, dates, organism, ...). */
  Notes: 0x06,
  /** History tree (LZMA-compressed XML since export version 15); skipped. */
  History: 0x07,
  /** `<AdditionalSequenceProperties>` XML (sticky ends, end modifications). */
  SequenceProperties: 0x08,
  /** The magic cookie; must be the first packet. */
  Cookie: 0x09,
  /** `<Features>` XML. */
  Features: 0x0a,
  /** `<CustomEnzymeSets>` XML. */
  CustomEnzymeSets: 0x0e,
  /** `<AlignableSequences>` XML. */
  AlignableSequences: 0x11,
  /** Protein residues (SnapGene `.prot` files) in place of the DNA packet. */
  ProteinSequence: 0x15,
  /** `<EnzymeVisibilities>` XML. */
  EnzymeVisibilities: 0x1c,
  /** RNA bases (SnapGene `.rna` files) in place of the DNA packet. */
  RnaSequence: 0x20,
} as const;

/**
 * Values of the cookie's "sequence type" field.
 * Sources: Biopython (1 = DNA); sgffp format spec (2 = protein, 7 = RNA).
 */
export const SnapGeneSequenceType = {
  Dna: 1,
  Protein: 2,
  Rna: 7,
} as const;

/** The 8 ASCII bytes that open every SnapGene cookie packet payload. */
export const SNAPGENE_MAGIC = 'SnapGene';

/** Size in bytes of a packet header (type byte + uint32 length). */
export const PACKET_HEADER_LENGTH = 5;

/** Size in bytes of a complete cookie payload: magic + three uint16 fields. */
export const COOKIE_PAYLOAD_LENGTH = 14;

/** One packet read from a file. `payload` is a view into the input (not a copy). */
export interface SnapGenePacket {
  type: number;
  /** Byte offset of the packet header in the file. */
  offset: number;
  payload: Uint8Array;
}

/** Result of splitting a file into packets. */
export interface PacketScan {
  packets: SnapGenePacket[];
  warnings: ParseWarning[];
  /** Set when the file ends inside a packet: the type and header offset of that packet. */
  truncated?: { type: number; offset: number };
}

/** Contents of the cookie packet. */
export interface SnapGeneCookie {
  /** 1 = DNA, 2 = protein, 7 = RNA (see {@link SnapGeneSequenceType}); 0 when the field is missing. */
  sequenceType: number;
  /** Format revision of the writer (15 for current SnapGene); 0 when missing. */
  exportVersion: number;
  /** Format revision needed to read the file; 0 when missing. */
  importVersion: number;
}

/** Big-endian unsigned 32-bit integer at `offset` (caller guarantees 4 bytes are available). */
function readUint32BE(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

/** Big-endian unsigned 16-bit integer at `offset` (caller guarantees 2 bytes are available). */
function readUint16BE(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/** True if `data[offset..offset+8)` spells `SnapGene`. */
function hasMagic(data: Uint8Array, offset: number): boolean {
  if (data.length < offset + SNAPGENE_MAGIC.length) return false;
  for (let i = 0; i < SNAPGENE_MAGIC.length; i++) {
    if (data[offset + i] !== SNAPGENE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * True if `data` starts with a SnapGene cookie packet (type 0x09 followed, after the 4-byte
 * length, by the ASCII text `SnapGene`). Only the first 13 bytes are inspected, so truncated
 * files are still recognised. This identifies the container format: SnapGene protein (`.prot`)
 * and RNA (`.rna`) files are recognised too, although only DNA files can be read.
 */
export function hasSnapGeneCookie(data: Uint8Array): boolean {
  return data.length >= PACKET_HEADER_LENGTH + SNAPGENE_MAGIC.length && data[0] === SnapGenePacketType.Cookie && hasMagic(data, PACKET_HEADER_LENGTH);
}

/**
 * Split a file into packets. Stops (with a warning) at the first incomplete packet header or
 * payload; never throws and always terminates (every iteration consumes at least 5 bytes).
 */
export function readPackets(data: Uint8Array): PacketScan {
  const packets: SnapGenePacket[] = [];
  const warnings: ParseWarning[] = [];
  let offset = 0;
  while (offset < data.length) {
    const remaining = data.length - offset;
    if (remaining < PACKET_HEADER_LENGTH) {
      warnings.push({
        message: `SnapGene file is truncated: ${remaining} trailing byte(s) at offset ${offset} do not form a complete packet header; ignored.`,
      });
      return { packets, warnings, truncated: { type: data[offset], offset } };
    }
    const type = data[offset];
    const length = readUint32BE(data, offset + 1);
    const start = offset + PACKET_HEADER_LENGTH;
    const available = data.length - start;
    if (length > available) {
      warnings.push({
        message: `SnapGene file is truncated: packet ${hex(type)} at offset ${offset} declares ${length} byte(s) but only ${available} remain; packet ignored.`,
      });
      return { packets, warnings, truncated: { type, offset } };
    }
    packets.push({ type, offset, payload: data.subarray(start, start + length) });
    offset = start + length;
  }
  return { packets, warnings };
}

/**
 * Read a cookie packet payload. Returns undefined if the payload does not start with
 * `SnapGene`; version fields that are missing (payload shorter than 14 bytes) are reported as 0.
 */
export function parseCookie(payload: Uint8Array): SnapGeneCookie | undefined {
  if (!hasMagic(payload, 0)) return undefined;
  const field = (offset: number) => (payload.length >= offset + 2 ? readUint16BE(payload, offset) : 0);
  return { sequenceType: field(8), exportVersion: field(10), importVersion: field(12) };
}

/** Encode a 14-byte cookie payload. */
export function encodeCookie(cookie: SnapGeneCookie): Uint8Array {
  const out = new Uint8Array(COOKIE_PAYLOAD_LENGTH);
  for (let i = 0; i < SNAPGENE_MAGIC.length; i++) out[i] = SNAPGENE_MAGIC.charCodeAt(i);
  const put16 = (offset: number, value: number) => {
    out[offset] = (value >>> 8) & 0xff;
    out[offset + 1] = value & 0xff;
  };
  put16(8, cookie.sequenceType);
  put16(10, cookie.exportVersion);
  put16(12, cookie.importVersion);
  return out;
}

/** Concatenate packets into a file image (header + payload for each, in the given order). */
export function encodePackets(packets: ReadonlyArray<{ type: number; payload: Uint8Array }>): Uint8Array {
  let total = 0;
  for (const p of packets) total += PACKET_HEADER_LENGTH + p.payload.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of packets) {
    const n = p.payload.length;
    out[offset] = p.type & 0xff;
    out[offset + 1] = (n >>> 24) & 0xff;
    out[offset + 2] = (n >>> 16) & 0xff;
    out[offset + 3] = (n >>> 8) & 0xff;
    out[offset + 4] = n & 0xff;
    out.set(p.payload, offset + PACKET_HEADER_LENGTH);
    offset += PACKET_HEADER_LENGTH + n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// UTF-8 (the XML packets are UTF-8). Implemented here instead of using TextDecoder /
// TextEncoder so the engine depends on ECMAScript only.
// ---------------------------------------------------------------------------

const REPLACEMENT_CHARACTER = 0xfffd;
/** Code units are buffered and flushed in chunks of this size (keeps String.fromCharCode's argument count small). */
const FLUSH_SIZE = 8192;

/** Accumulates UTF-16 code units into a string without per-character concatenation. */
class StringBuilder {
  private parts: string[] = [];
  private units: number[] = [];

  push(unit: number): void {
    this.units.push(unit);
    if (this.units.length >= FLUSH_SIZE) this.flush();
  }

  pushCodePoint(cp: number): void {
    if (cp < 0x10000) {
      this.push(cp);
    } else {
      const v = cp - 0x10000;
      this.push(0xd800 + (v >> 10));
      this.push(0xdc00 + (v & 0x3ff));
    }
  }

  toString(): string {
    this.flush();
    return this.parts.join('');
  }

  private flush(): void {
    if (this.units.length > 0) {
      this.parts.push(String.fromCharCode(...this.units));
      this.units = [];
    }
  }
}

/** Result of {@link decodeUtf8WithReplacements}. */
export interface Utf8Decoding {
  text: string;
  /**
   * Number of ill-formed byte sequences that were replaced by U+FFFD (0 for valid UTF-8; a U+FFFD
   * that the input itself encodes, as EF BF BD, is ordinary text and is not counted).
   */
  replacements: number;
}

/**
 * Decode UTF-8 bytes exactly like the WHATWG Encoding Standard's UTF-8 decoder
 * (https://encoding.spec.whatwg.org/#utf-8-decoder), i.e. like `new TextDecoder('utf-8')`:
 * a leading byte order mark is dropped and every maximal ill-formed subsequence becomes U+FFFD.
 * Also reports how many such replacements were made, so that callers can warn about text that
 * is not UTF-8 (e.g. ISO-8859-1) instead of corrupting it silently.
 */
export function decodeUtf8WithReplacements(bytes: Uint8Array): Utf8Decoding {
  const out = new StringBuilder();
  let replacements = 0;
  let codePoint = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (; i < bytes.length; i++) {
    const b = bytes[i];
    if (needed === 0) {
      if (b <= 0x7f) {
        out.push(b);
      } else if (b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        codePoint = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        if (b === 0xe0) lower = 0xa0; // reject overlong 3-byte forms
        if (b === 0xed) upper = 0x9f; // reject UTF-16 surrogates
        needed = 2;
        codePoint = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        if (b === 0xf0) lower = 0x90; // reject overlong 4-byte forms
        if (b === 0xf4) upper = 0x8f; // reject code points above U+10FFFF
        needed = 3;
        codePoint = b & 0x07;
      } else {
        out.push(REPLACEMENT_CHARACTER);
        replacements++;
      }
      continue;
    }
    if (b < lower || b > upper) {
      // Ill-formed sequence: emit one replacement character and reprocess this byte.
      codePoint = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      out.push(REPLACEMENT_CHARACTER);
      replacements++;
      i--;
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    codePoint = (codePoint << 6) | (b & 0x3f);
    seen++;
    if (seen === needed) {
      out.pushCodePoint(codePoint);
      codePoint = 0;
      needed = 0;
      seen = 0;
    }
  }
  if (needed !== 0) {
    out.push(REPLACEMENT_CHARACTER);
    replacements++;
  }
  return { text: out.toString(), replacements };
}

/** {@link decodeUtf8WithReplacements} without the replacement count: like `new TextDecoder('utf-8').decode(bytes)`. */
export function decodeUtf8(bytes: Uint8Array): string {
  return decodeUtf8WithReplacements(bytes).text;
}

/**
 * Encode a string as UTF-8, like `new TextEncoder().encode(text)`: unpaired surrogates
 * become U+FFFD.
 */
export function encodeUtf8(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3); // worst case: 3 bytes per UTF-16 code unit
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out[n++] = c;
      continue;
    }
    if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3f);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out[n++] = 0xf0 | (cp >> 18);
        out[n++] = 0x80 | ((cp >> 12) & 0x3f);
        out[n++] = 0x80 | ((cp >> 6) & 0x3f);
        out[n++] = 0x80 | (cp & 0x3f);
        i++;
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = REPLACEMENT_CHARACTER; // unpaired surrogate
    out[n++] = 0xe0 | (c >> 12);
    out[n++] = 0x80 | ((c >> 6) & 0x3f);
    out[n++] = 0x80 | (c & 0x3f);
  }
  return out.slice(0, n);
}
