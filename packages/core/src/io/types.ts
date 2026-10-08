import type { SeqRecord } from '../types';

/** A non-fatal problem found while reading a file. Parsers never throw on bad input; they warn. */
export interface ParseWarning {
  message: string;
  /** 1-based line number in the source text, when known. */
  line?: number;
  /** Index of the record (in a multi-record file) the warning belongs to, when known. */
  recordIndex?: number;
}

/** Result of reading a file: zero or more records plus warnings. */
export interface ParseResult {
  records: SeqRecord[];
  warnings: ParseWarning[];
}
