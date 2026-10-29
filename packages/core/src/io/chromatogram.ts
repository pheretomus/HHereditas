/**
 * Sanger chromatogram readers: ABI ABIF (`.ab1`), Standard Chromatogram Format (`.scf` v2/v3) and ZTR (the format
 * SnapGene embeds in a `.dna` file, Packet `0x10` -> `0x12`). Each returns the called bases with, when the file stores
 * them, their Phred qualities, the four signal channels and the peak position of every base.
 *
 * ZTR: chunks BASE, BPOS, CNF4/CNF1, SMP4 and TEXT, with the compression formats raw, RLE, zlib, delta (8/16/32 bit),
 * 16-to-8, 32-to-8 and follow1 (io_lib's ZTR 1.2/1.3).
 */
import type { ChromatogramTrace } from '../types';
import { inflateRaw } from './inflate';

/** Called bases of a chromatogram and what else the file stores about them (arrays are as long as `bases`). */
export interface TraceReadData {
  bases: string;
  quality?: number[];
  trace?: ChromatogramTrace;
  /** ISO `YYYY-MM-DD`. */
  runDate?: string;
}

const IUPAC = /[ACGTRYSWKMBDHVN]/;

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function s16(b: Uint8Array, o: number): number {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
}

/**
 * Keeps the IUPAC letters of `raw` and the matching entries of the per-base arrays (a base whose letter is dropped
 * loses its quality and peak too), so all arrays stay as long as the bases.
 */
function keepBases(raw: string, quality: number[] | undefined, peaks: number[] | undefined): { bases: string; quality?: number[]; peaks?: number[] } {
  let bases = '';
  const q: number[] = [];
  const p: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i].toUpperCase();
    if (!IUPAC.test(ch)) continue;
    bases += ch;
    if (quality) q.push(Math.max(0, quality[i] ?? 0));
    if (peaks) p.push(peaks[i] ?? 0);
  }
  return { bases, quality: quality ? q : undefined, peaks: peaks ? p : undefined };
}

function makeTrace(channels: number[][] | null, peaks: number[] | undefined): ChromatogramTrace | undefined {
  if (!channels || !peaks || channels.length !== 4) return undefined;
  const n = channels[0].length;
  if (n === 0 || channels.some((c) => c.length !== n)) return undefined;
  return { a: channels[0], c: channels[1], g: channels[2], t: channels[3], peaks: peaks.map((p) => Math.max(0, Math.min(n - 1, p))) };
}

function isoDate(y: number, m: number, d: number): string | undefined {
  if (y < 1980 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Reads any of the three chromatogram formats; null when `data` is none of them. */
export function parseChromatogram(data: Uint8Array): TraceReadData | null {
  try {
    if (data.length >= 4 && data[0] === 0x41 && data[1] === 0x42 && data[2] === 0x49 && data[3] === 0x46) return parseAbif(data);
    if (data.length >= 128 && data[0] === 0x2e && data[1] === 0x73 && data[2] === 0x63 && data[3] === 0x66) return parseScf(data);
    if (data.length >= 10 && data[0] === 0xae && data[1] === 0x5a && data[2] === 0x54 && data[3] === 0x52) return parseZtr(data);
  } catch {
    return null;
  }
  return null;
}

// ---- ABIF (.ab1) -------------------------------------------------------------------------------------------------

function parseAbif(data: Uint8Array): TraceReadData | null {
  if (data.length < 34) return null;
  const numElements = u32(data, 18);
  const dirOffset = u32(data, 26);
  const items = new Map<string, Uint8Array>();
  for (let i = 0; i < numElements && dirOffset + (i + 1) * 28 <= data.length; i++) {
    const e = dirOffset + i * 28;
    const key = String.fromCharCode(data[e], data[e + 1], data[e + 2], data[e + 3]) + u32(data, e + 4);
    const size = u32(data, e + 16);
    const src = size <= 4 ? e + 20 : u32(data, e + 20);
    if (src + size <= data.length) items.set(key, data.subarray(src, src + size));
  }
  // PBAS / PCON / PLOC 2 are the edited base calls, 1 the original ones; prefer 2 like other readers
  for (const num of [2, 1]) {
    const pbas = items.get(`PBAS${num}`);
    if (!pbas || pbas.length === 0) continue;
    const raw = String.fromCharCode(...pbas);
    const pcon = items.get(`PCON${num}`);
    const quality = pcon && pcon.length === pbas.length ? [...pcon] : undefined;
    const ploc = items.get(`PLOC${num}`) ?? items.get(`PLOC${3 - num}`);
    const peaks = ploc && ploc.length === 2 * pbas.length ? Array.from({ length: pbas.length }, (_, k) => s16(ploc, 2 * k)) : undefined;
    const kept = keepBases(raw, quality, peaks);
    if (!kept.bases) continue;
    return { bases: kept.bases, quality: kept.quality, trace: makeTrace(abifChannels(items), kept.peaks), runDate: abifDate(items) };
  }
  return null;
}

/** Analysed signal (DATA9-12, else raw DATA1-4) in A, C, G, T order, using the dye order of FWO_. */
function abifChannels(items: Map<string, Uint8Array>): number[][] | null {
  const fwo = items.get('FWO_1');
  if (!fwo || fwo.length < 4) return null;
  const order = String.fromCharCode(fwo[0], fwo[1], fwo[2], fwo[3]).toUpperCase();
  for (const first of [9, 1]) {
    const series: number[][] = [];
    for (let k = 0; k < 4; k++) {
      const d = items.get(`DATA${first + k}`);
      if (!d) break;
      series.push(Array.from({ length: d.length >> 1 }, (_, j) => s16(d, 2 * j)));
    }
    if (series.length !== 4) continue;
    const out: number[][] = [];
    for (const base of 'ACGT') {
      const k = order.indexOf(base);
      if (k < 0) return null;
      out.push(series[k]);
    }
    return out;
  }
  return null;
}

function abifDate(items: Map<string, Uint8Array>): string | undefined {
  const d = items.get('RUND1') ?? items.get('RUND2');
  return d && d.length >= 4 ? isoDate(u16(d, 0), d[2], d[3]) : undefined;
}

// ---- SCF ---------------------------------------------------------------------------------------------------------

function parseScf(data: Uint8Array): TraceReadData | null {
  const samples = u32(data, 4);
  const samplesOffset = u32(data, 8);
  const n = u32(data, 12);
  const basesOffset = u32(data, 24);
  const v3 = data[36] === 0x33;
  const sampleSize = u32(data, 40) === 1 ? 1 : 2;
  if (n === 0 || n > 200_000) return null;
  let raw = '';
  const quality: number[] = [];
  const peaks: number[] = [];
  const called = (ch: string, pa: number, pc: number, pg: number, pt: number) =>
    ch === 'A' ? pa : ch === 'C' ? pc : ch === 'G' ? pg : ch === 'T' ? pt : 0;
  if (v3) {
    // peak indices (4*N), probabilities A/C/G/T (N each), then the N base letters
    const prob = basesOffset + n * 4;
    const chars = basesOffset + n * 8;
    if (chars + n > data.length) return null;
    for (let i = 0; i < n; i++) {
      const ch = String.fromCharCode(data[chars + i]).toUpperCase();
      raw += ch;
      peaks.push(u32(data, basesOffset + 4 * i));
      quality.push(called(ch, data[prob + i], data[prob + n + i], data[prob + 2 * n + i], data[prob + 3 * n + i]));
    }
  } else {
    // 12-byte records: peak index (4), probabilities A/C/G/T (4), base letter (1), spare (3)
    if (basesOffset + n * 12 > data.length) return null;
    for (let i = 0; i < n; i++) {
      const r = basesOffset + i * 12;
      const ch = String.fromCharCode(data[r + 8]).toUpperCase();
      raw += ch;
      peaks.push(u32(data, r));
      quality.push(called(ch, data[r + 4], data[r + 5], data[r + 6], data[r + 7]));
    }
  }
  const kept = keepBases(raw, quality.some((q) => q > 0) ? quality : undefined, peaks);
  return { bases: kept.bases, quality: kept.quality, trace: makeTrace(scfChannels(data, samples, samplesOffset, sampleSize, v3), kept.peaks) };
}

function scfChannels(data: Uint8Array, samples: number, offset: number, size: number, v3: boolean): number[][] | null {
  if (samples === 0 || offset + samples * 4 * size > data.length) return null;
  const read = (o: number) => (size === 1 ? data[o] : u16(data, o));
  const mask = size === 1 ? 0xff : 0xffff;
  const out: number[][] = [];
  for (let c = 0; c < 4; c++) {
    const ch: number[] = [];
    for (let i = 0; i < samples; i++) ch.push(v3 ? read(offset + (c * samples + i) * size) : read(offset + (i * 4 + c) * size));
    if (v3) {
      // v3 stores each channel as second-order differences
      for (let pass = 0; pass < 2; pass++) {
        let p = 0;
        for (let i = 0; i < samples; i++) p = ch[i] = (ch[i] + p) & mask;
      }
    }
    out.push(ch);
  }
  return out;
}

// ---- ZTR ---------------------------------------------------------------------------------------------------------

/** Undoes the compression chain of one ZTR chunk; returns the raw chunk (its first byte is the raw format 0). */
function ztrDecode(input: Uint8Array): Uint8Array {
  let x = input;
  for (let guard = 0; guard < 16; guard++) {
    const f = x[0];
    if (f === 0) return x;
    if (f === 1) x = ztrRle(x);
    else if (f === 2) x = inflateRaw(x, 7).output; // format, 4-byte length, 2-byte zlib header, then DEFLATE
    else if (f === 64 || f === 65 || f === 66) x = ztrDelta(x, f === 64 ? 1 : f === 65 ? 2 : 4);
    else if (f === 70 || f === 71) x = ztrTo8(x, f === 70 ? 2 : 4);
    else if (f === 72) x = ztrFollow(x);
    else throw new Error(`ZTR format ${f}`);
  }
  throw new Error('ZTR chain too long');
}

function ztrRle(x: Uint8Array): Uint8Array {
  const n = x[1] | (x[2] << 8) | (x[3] << 16) | (x[4] << 24);
  const g = x[5];
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 6; i < x.length && o < n; ) {
    const b = x[i++];
    if (b !== g) out[o++] = b;
    else {
      const c = x[i++];
      if (c === 0) out[o++] = g;
      else {
        const v = x[i++];
        for (let k = 0; k < c && o < n; k++) out[o++] = v;
      }
    }
  }
  return out;
}

function ztrDelta(x: Uint8Array, w: number): Uint8Array {
  const level = x[1];
  const off = w === 4 ? 4 : 2;
  const m = 2 ** (8 * w);
  const count = Math.floor((x.length - off) / w);
  const out = new Uint8Array(count * w);
  let p1 = 0, p2 = 0, p3 = 0;
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let k = 0; k < w; k++) v = v * 256 + x[off + i * w + k];
    const pred = level === 1 ? p1 : level === 2 ? 2 * p1 - p2 : 3 * p1 - 3 * p2 + p3;
    const y = (((v + pred) % m) + m) % m;
    for (let k = w - 1, t = y; k >= 0; k--, t = Math.floor(t / 256)) out[i * w + k] = t % 256;
    p3 = p2; p2 = p1; p1 = y;
  }
  return out;
}

function ztrTo8(x: Uint8Array, w: number): Uint8Array {
  const out: number[] = [];
  for (let i = 1; i < x.length; ) {
    const v = x[i++];
    if (v === 0x80) {
      for (let k = 0; k < w; k++) out.push(x[i++]);
    } else {
      const fill = v & 0x80 ? 0xff : 0;
      for (let k = 0; k < w - 1; k++) out.push(fill);
      out.push(v);
    }
  }
  return new Uint8Array(out);
}

function ztrFollow(x: Uint8Array): Uint8Array {
  const next = x.subarray(1, 257);
  const d = x.subarray(257);
  const out = new Uint8Array(d.length);
  if (d.length === 0) return out;
  out[0] = d[0];
  for (let i = 1; i < d.length; i++) out[i] = (next[out[i - 1]] - d[i]) & 0xff;
  return out;
}

function parseZtr(data: Uint8Array): TraceReadData | null {
  const chunks: Array<{ type: string; meta: string; body: Uint8Array }> = [];
  for (let r = 10; r + 12 <= data.length; ) {
    const type = String.fromCharCode(data[r], data[r + 1], data[r + 2], data[r + 3]);
    const metaLen = u32(data, r + 4);
    const meta = String.fromCharCode(...data.subarray(r + 8, r + 8 + metaLen));
    r += 8 + metaLen;
    const len = u32(data, r);
    const raw = data.subarray(r + 4, r + 4 + len);
    r += 4 + len;
    try {
      chunks.push({ type, meta, body: ztrDecode(raw) });
    } catch {
      // an unknown compression only loses that chunk
    }
  }
  const get = (t: string) => chunks.find((c) => c.type === t)?.body;
  const base = get('BASE');
  if (!base) return null;
  const raw = String.fromCharCode(...base.subarray(1));
  const n = raw.length;
  let quality: number[] | undefined;
  const cnf = get('CNF4') ?? get('CNF1');
  if (cnf && cnf.length >= 1 + n) quality = Array.from(cnf.subarray(1, 1 + n), (v) => (v > 127 ? 0 : v));
  let peaks: number[] | undefined;
  const bpos = get('BPOS');
  if (bpos && bpos.length >= 4 + 4 * n) peaks = Array.from({ length: n }, (_, i) => u32(bpos, 4 + 4 * i));
  // processed traces when the file has both kinds
  const smpChunks = chunks.filter((c) => c.type === 'SMP4');
  const smp = (smpChunks.find((c) => c.meta.includes('PROC')) ?? smpChunks[0])?.body;
  let channels: number[][] | null = null;
  if (smp && smp.length > 2) {
    const total = (smp.length - 2) >> 1;
    const per = Math.floor(total / 4);
    channels = [0, 1, 2, 3].map((c) => Array.from({ length: per }, (_, i) => u16(smp, 2 + 2 * (c * per + i))));
  }
  const kept = keepBases(raw, quality, peaks);
  return { bases: kept.bases, quality: kept.quality, trace: makeTrace(channels, kept.peaks), runDate: ztrDate(get('TEXT')) };
}

/** Run date from the TEXT chunk (`RUND` "20260721.130230 - ..." or `DATE`). */
function ztrDate(text: Uint8Array | undefined): string | undefined {
  if (!text) return undefined;
  const parts = String.fromCharCode(...text.subarray(1)).split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== 'RUND') continue;
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts[i + 1]);
    if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return undefined;
}
