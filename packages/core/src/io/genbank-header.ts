/**
 * GenBank header blocks between the LOCUS line and the FEATURES table.
 *
 * Entry organization (GenBank release notes 3.4.2): a keyword starts in column 1, a
 * sub-keyword in column 3 or 4 (AUTHORS, ORGANISM, PUBMED, ...), and continuation lines are
 * blank in columns 1-12; data starts in column 13 (0-based column 12) and lines end at
 * column 80 at most.
 *
 * Modelled blocks: DEFINITION, ACCESSION, VERSION, KEYWORDS, SOURCE, ORGANISM (+ taxonomy
 * lineage) and COMMENT. Every other block (REFERENCE and its sub-keywords, DBLINK, DBSOURCE,
 * PROJECT, NID, PID, SEGMENT, PRIMARY, unknown keywords) is kept verbatim, in order, in
 * `RecordMeta.extraHeaderLines` and written back at its usual place.
 */
import type { SeqRecord } from '../types';
import type { WarnFn } from './genbank-features';
import { indentation } from './genbank-features';
import { appendAll } from './genbank-text';

/** Keys of `RecordMeta.extras` used by the GenBank reader and writer. */
export const GENBANK_EXTRA_KEYS = Object.freeze({
  /** LOCUS molecule token as written, e.g. 'ds-DNA', 'mRNA', 'cRNA' (round-trips the LOCUS line). */
  moleculeType: 'genbank.moleculeType',
  /** Taxonomic lineage from the ORGANISM block, e.g. 'Bacteria; Pseudomonadota; ...; Escherichia.' */
  taxonomy: 'genbank.taxonomy',
});

/** Data column of header lines (0-based). */
const DATA_COLUMN = 12;
/** Longest header line written (GenBank release notes 3.4.2: data in positions 13 to 80). */
const HEADER_WIDTH = 80;
const DATA_WIDTH = HEADER_WIDTH - DATA_COLUMN;
const CONTINUATION = ' '.repeat(DATA_COLUMN);

/** Header fields read from a GenBank record. */
export interface HeaderData {
  /** DEFINITION text, lines joined with single spaces, without the final period. */
  description: string;
  accession?: string;
  version?: string;
  /** KEYWORDS text without the final period. */
  keywords?: string;
  source?: string;
  organism?: string;
  /** ORGANISM lineage lines, joined with single spaces. */
  taxonomy?: string;
  /** One entry per COMMENT block, lines joined with '\n' (indentation after column 12 kept). */
  comments: string[];
  /** Verbatim lines of all other blocks, in file order. */
  extraHeaderLines: string[];
}

/** Keyword or sub-keyword starting a header block, or null for continuation lines. */
export function headerKeyword(line: string): string | null {
  const m = /^ {0,3}([A-Z][A-Z0-9_]*)(?=\s|$)/.exec(line);
  return m ? m[1] : null;
}

interface Block {
  keyword: string;
  /** 1-based line number of the keyword line. */
  line: number;
  lines: string[];
}

function splitBlocks(lines: readonly string[], start: number, end: number, warn: WarnFn): Block[] {
  const blocks: Block[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const keyword = headerKeyword(line);
    if (keyword !== null) blocks.push({ keyword, line: i + 1, lines: [line] });
    else if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
    else if (line !== '') warn('header text before the first keyword was ignored', i + 1);
  }
  for (const b of blocks) {
    while (b.lines.length > 1 && b.lines[b.lines.length - 1] === '') b.lines.pop();
  }
  return blocks;
}

/**
 * Data of each line of a block: the first line without its keyword, continuation lines
 * without the 12-column indent (or without all indentation when they are indented less).
 */
function blockData(block: Block): string[] {
  const first = block.lines[0];
  const keywordEnd = first.indexOf(block.keyword) + block.keyword.length;
  const data = [
    first.length >= DATA_COLUMN && first.slice(0, DATA_COLUMN).trim() === block.keyword
      ? first.slice(DATA_COLUMN)
      : first.slice(keywordEnd).trimStart(),
  ];
  for (let k = 1; k < block.lines.length; k++) {
    const line = block.lines[k];
    data.push(indentation(line) >= DATA_COLUMN ? line.slice(DATA_COLUMN) : line.trimStart());
  }
  return data;
}

/** Lines joined with single spaces, runs of white space collapsed. */
function joinedText(data: readonly string[]): string {
  return data.join(' ').replace(/\s+/g, ' ').trim();
}

/** Text without one final period ('.' alone means "no data"). */
function withoutFinalPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1).trimEnd() : text;
}

/** Placeholder-aware value: '' and '.' mean "absent". */
function present(text: string): string | undefined {
  return text === '' || text === '.' ? undefined : text;
}

/**
 * Lineage lines are recognised like Biopython 1.88 (`GenBankScanner._feed_header_lines`):
 * a continuation line belongs to the lineage once the lineage has started, if it contains ';',
 * or if it is one of these single-rank lineages; otherwise it continues a long organism name
 * (GenBank release notes 3.4.2 note on ORGANISM line wrapping).
 */
const SINGLE_RANK_LINEAGES: ReadonlySet<string> = new Set([
  'Bacteria.',
  'Archaea.',
  'Eukaryota.',
  'Unclassified.',
  'Viruses.',
  'cellular organisms.',
  'other sequences.',
  'unclassified sequences.',
]);

function readOrganism(data: readonly string[]): { organism?: string; taxonomy?: string } {
  let organism = data[0].trim();
  const lineage: string[] = [];
  for (let k = 1; k < data.length; k++) {
    const text = data[k].trim();
    if (text === '') continue;
    if (lineage.length > 0 || text.includes(';') || SINGLE_RANK_LINEAGES.has(text)) lineage.push(text);
    else if (text !== '.') organism += ' ' + text;
  }
  const out: { organism?: string; taxonomy?: string } = {};
  const o = present(organism.replace(/\s+/g, ' '));
  if (o !== undefined) out.organism = o;
  const t = present(joinedText(lineage));
  if (t !== undefined) out.taxonomy = t;
  return out;
}

/**
 * Keywords whose blocks are modelled (or structural) and therefore never kept verbatim:
 * GenBank release notes 3.4.2 entry keywords plus the post-feature sections that Biopython 1.88
 * treats as sequence headers (`GenBankScanner.SEQUENCE_HEADERS`: CONTIG, ORIGIN, BASE COUNT, WGS,
 * TSA, TLS).
 */
const MODELLED_KEYWORDS: ReadonlySet<string> = new Set([
  'LOCUS',
  'DEFINITION',
  'ACCESSION',
  'VERSION',
  'KEYWORDS',
  'SOURCE',
  'ORGANISM',
  'COMMENT',
  'FEATURES',
  'ORIGIN',
  'BASE',
  'CONTIG',
  'WGS',
  'WGS_SCAFLD',
  'TSA',
  'TLS',
]);

/**
 * Read the header lines `[start, end)` (after LOCUS, before FEATURES / ORIGIN).
 * Lines are already free of trailing blanks and leading tabs.
 */
export function readHeader(lines: readonly string[], start: number, end: number, warn: WarnFn): HeaderData {
  const header: HeaderData = { description: '', comments: [], extraHeaderLines: [] };
  const seen = new Set<string>();
  for (const block of splitBlocks(lines, start, end, warn)) {
    const data = blockData(block);
    const once = (): boolean => {
      if (!seen.has(block.keyword)) {
        seen.add(block.keyword);
        return true;
      }
      warn(`repeated ${block.keyword} block ignored`, block.line);
      return false;
    };
    switch (block.keyword) {
      case 'DEFINITION': {
        const text = withoutFinalPeriod(joinedText(data));
        header.description = header.description === '' ? text : `${header.description} ${text}`;
        break;
      }
      case 'ACCESSION': {
        const text = present(joinedText(data));
        if (text !== undefined) header.accession = header.accession === undefined ? text : `${header.accession} ${text}`;
        break;
      }
      case 'KEYWORDS': {
        const text = present(withoutFinalPeriod(joinedText(data)));
        if (text !== undefined) header.keywords = header.keywords === undefined ? text : `${header.keywords}; ${text}`;
        break;
      }
      case 'VERSION':
        if (once()) {
          const text = present(joinedText(data));
          if (text !== undefined) header.version = text;
        }
        break;
      case 'SOURCE':
        if (once()) {
          const text = present(joinedText(data));
          if (text !== undefined) header.source = text;
        }
        break;
      case 'ORGANISM':
        if (once()) Object.assign(header, readOrganism(data));
        break;
      case 'COMMENT':
        header.comments.push(data.join('\n'));
        break;
      default:
        if (MODELLED_KEYWORDS.has(block.keyword)) warn(`misplaced ${block.keyword} line in the header ignored`, block.line);
        else appendAll(header.extraHeaderLines, block.lines);
    }
  }
  return header;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Greedy word wrap; words longer than `width` get a line of their own. */
export function wrapWords(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = words[0];
  for (let k = 1; k < words.length; k++) {
    if (current.length + 1 + words[k].length <= width) current += ' ' + words[k];
    else {
      lines.push(current);
      current = words[k];
    }
  }
  lines.push(current);
  return lines;
}

/** A keyword block with word-wrapped data (continuation lines indented to column 13). */
function field(keyword: string, text: string): string[] {
  return wrapWords(text, DATA_WIDTH).map((part, k) => (k === 0 ? keyword.padEnd(DATA_COLUMN) : CONTINUATION) + part);
}

/** Lines of one COMMENT block; only lines too long for the data columns are re-wrapped. */
function commentBlock(comment: string): string[] {
  const out: string[] = [];
  for (const line of comment.split('\n')) {
    const parts = line.length <= DATA_WIDTH ? [line] : wrapWords(line, DATA_WIDTH);
    for (const part of parts) out.push((out.length === 0 ? 'COMMENT'.padEnd(DATA_COLUMN) : CONTINUATION) + part);
  }
  return out;
}

/**
 * Output slots of verbatim blocks, in NCBI flat-file order: after ACCESSION (NID, PID), after
 * VERSION (DBLINK, PROJECT, DBSOURCE), after KEYWORDS (SEGMENT), after ORGANISM (REFERENCE and
 * its sub-keywords, unknown keywords), after COMMENT (PRIMARY).
 */
const AFTER_ACCESSION = 1;
const AFTER_VERSION = 2;
const AFTER_KEYWORDS = 3;
const AFTER_ORGANISM = 4;
const AFTER_COMMENT = 5;

const CANONICAL_SLOT: ReadonlyMap<string, number> = new Map([
  ['NID', AFTER_ACCESSION],
  ['PID', AFTER_ACCESSION],
  ['DBLINK', AFTER_VERSION],
  ['PROJECT', AFTER_VERSION],
  ['DBSOURCE', AFTER_VERSION],
  ['SEGMENT', AFTER_KEYWORDS],
  ['PRIMARY', AFTER_COMMENT],
]);

/**
 * Verbatim blocks with their output slot. A block never moves before the block that preceded
 * it in the source (slot = max(canonical slot, previous slot)), so re-reading the output gives
 * the same `extraHeaderLines` in the same order. Orphan continuation lines and modelled
 * keywords cannot come from `readHeader` and are skipped defensively.
 */
function placeExtraBlocks(extraLines: readonly string[]): { slot: number; lines: string[] }[] {
  const blocks: { slot: number; lines: string[] }[] = [];
  let skipping = true;
  let previous = AFTER_ACCESSION;
  for (const line of extraLines) {
    const keyword = headerKeyword(line);
    if (keyword === null) {
      if (!skipping) blocks[blocks.length - 1].lines.push(line);
      continue;
    }
    skipping = MODELLED_KEYWORDS.has(keyword);
    if (skipping) continue;
    previous = Math.max(CANONICAL_SLOT.get(keyword) ?? AFTER_ORGANISM, previous);
    blocks.push({ slot: previous, lines: [line] });
  }
  return blocks;
}

/**
 * Header lines from DEFINITION to the last line before FEATURES.
 * DEFINITION and KEYWORDS get their final period back; absent ACCESSION, VERSION, KEYWORDS,
 * SOURCE and ORGANISM are written as '.'; text is word-wrapped at 80 columns.
 */
export function formatHeader(record: SeqRecord): string[] {
  const meta = record.meta;
  const out: string[] = [];
  const extras = placeExtraBlocks(meta.extraHeaderLines ?? []);
  let nextExtra = 0;
  const flushExtras = (upTo: number) => {
    while (nextExtra < extras.length && extras[nextExtra].slot <= upTo) appendAll(out, extras[nextExtra++].lines);
  };

  appendAll(out, field('DEFINITION', `${record.description.replace(/\s+/g, ' ').trim()}.`));
  appendAll(out, field('ACCESSION', meta.accession?.trim() || '.'));
  flushExtras(AFTER_ACCESSION);
  appendAll(out, field('VERSION', meta.version?.trim() || '.'));
  flushExtras(AFTER_VERSION);
  const keywords = meta.keywords?.trim();
  appendAll(out, field('KEYWORDS', keywords ? `${keywords}.` : '.'));
  flushExtras(AFTER_KEYWORDS);
  appendAll(out, field('SOURCE', meta.source?.trim() || '.'));
  appendAll(out, field('  ORGANISM', meta.organism?.trim() || '.'));
  const taxonomy = meta.extras?.[GENBANK_EXTRA_KEYS.taxonomy]?.trim();
  if (taxonomy) for (const part of wrapWords(taxonomy, DATA_WIDTH)) out.push(CONTINUATION + part);
  flushExtras(AFTER_ORGANISM);
  for (const comment of meta.comments ?? []) appendAll(out, commentBlock(comment));
  flushExtras(AFTER_COMMENT);
  return out;
}
