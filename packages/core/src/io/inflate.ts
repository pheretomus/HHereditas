// Pure-TypeScript RFC 1951 DEFLATE decompressor (zero Node/DOM deps), used for BGZF/BAM and ZTR chromatograms.

const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i <= 143; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 144; i <= 255; i++) FIXED_LIT_LEN[i] = 9;
for (let i = 256; i <= 279; i++) FIXED_LIT_LEN[i] = 7;
for (let i = 280; i <= 287; i++) FIXED_LIT_LEN[i] = 8;

const FIXED_DIST = new Uint8Array(32);
FIXED_DIST.fill(5);

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

interface HuffmanTable {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuffman(lengths: Uint8Array, maxSymbols = lengths.length): HuffmanTable {
  const counts = new Uint16Array(16);
  for (let i = 0; i < maxSymbols; i++) {
    const l = lengths[i];
    if (l > 0 && l < 16) counts[l]++;
  }
  const offsets = new Uint16Array(16);
  let total = 0;
  for (let bits = 1; bits <= 15; bits++) {
    offsets[bits] = total;
    total += counts[bits];
  }
  const symbols = new Uint16Array(total);
  for (let i = 0; i < maxSymbols; i++) {
    const l = lengths[i];
    if (l > 0 && l < 16) {
      symbols[offsets[l]++] = i;
    }
  }
  return { counts, symbols };
}

const FIXED_LIT_TABLE = buildHuffman(FIXED_LIT_LEN);
const FIXED_DIST_TABLE = buildHuffman(FIXED_DIST);

/** Inflates a raw DEFLATE stream that starts at byte `startOffset`; throws on corrupt input. */
export function inflateRaw(data: Uint8Array, startOffset: number): { output: Uint8Array; bytesRead: number } {
  let bitPos = startOffset * 8;
  const maxBits = data.length * 8;

  const bits = (n: number): number => {
    let val = 0;
    for (let i = 0; i < n; i++) {
      if (bitPos >= maxBits) throw new Error('Truncated deflate stream');
      const byteIdx = bitPos >>> 3;
      const bitIdx = bitPos & 7;
      val |= ((data[byteIdx] >>> bitIdx) & 1) << i;
      bitPos++;
    }
    return val;
  };

  const decode = (table: HuffmanTable): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = table.counts[len];
      if (code - count < first) {
        return table.symbols[index + (code - first)];
      }
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('Invalid Huffman code');
  };

  const out: number[] = [];
  let bfinal = 0;
  while (!bfinal) {
    bfinal = bits(1);
    const btype = bits(2);
    if (btype === 0) {
      bitPos = (bitPos + 7) & ~7;
      const bytePos = bitPos >>> 3;
      if (bytePos + 4 > data.length) throw new Error('Truncated stored block');
      const len = data[bytePos] | (data[bytePos + 1] << 8);
      const srcStart = bytePos + 4;
      if (srcStart + len > data.length) throw new Error('Truncated stored block payload');
      for (let i = 0; i < len; i++) out.push(data[srcStart + i]);
      bitPos = (srcStart + len) * 8;
    } else if (btype === 1 || btype === 2) {
      let litTable = FIXED_LIT_TABLE;
      let distTable = FIXED_DIST_TABLE;
      if (btype === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const clenLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clenLengths[CLEN_ORDER[i]] = bits(3);
        const clenTable = buildHuffman(clenLengths, 19);
        const allLengths = new Uint8Array(hlit + hdist);
        let idx = 0;
        while (idx < hlit + hdist) {
          const sym = decode(clenTable);
          if (sym < 16) {
            allLengths[idx++] = sym;
          } else if (sym === 16) {
            const prev = idx > 0 ? allLengths[idx - 1] : 0;
            const rep = bits(2) + 3;
            for (let k = 0; k < rep && idx < allLengths.length; k++) allLengths[idx++] = prev;
          } else if (sym === 17) {
            const rep = bits(3) + 3;
            for (let k = 0; k < rep && idx < allLengths.length; k++) allLengths[idx++] = 0;
          } else {
            const rep = bits(7) + 11;
            for (let k = 0; k < rep && idx < allLengths.length; k++) allLengths[idx++] = 0;
          }
        }
        litTable = buildHuffman(allLengths.subarray(0, hlit), hlit);
        distTable = buildHuffman(allLengths.subarray(hlit, hlit + hdist), hdist);
      }

      while (true) {
        const sym = decode(litTable);
        if (sym < 256) {
          out.push(sym);
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          const length = LEN_BASE[lenIdx] + (LEN_EXTRA[lenIdx] ? bits(LEN_EXTRA[lenIdx]) : 0);
          const distSym = decode(distTable);
          const dist = DIST_BASE[distSym] + (DIST_EXTRA[distSym] ? bits(DIST_EXTRA[distSym]) : 0);
          const start = out.length - dist;
          if (start < 0) throw new Error('Invalid deflate distance');
          for (let i = 0; i < length; i++) out.push(out[start + i]);
        }
      }
    } else {
      throw new Error(`Invalid deflate block type ${btype}`);
    }
  }

  const endByte = (bitPos + 7) >>> 3;
  return { output: new Uint8Array(out), bytesRead: endByte - startOffset };
}
