/**
 * Text-level helpers shared by the flat-file readers (GenBank and FASTA).
 */

/** U+FEFF, the UTF-8 byte-order mark once decoded (Unicode 15.0 section 23.8 "Specials"). */
const BYTE_ORDER_MARK = 0xfeff;

/** Number of byte-order marks at the start of `line`. */
function leadingByteOrderMarks(line: string): number {
  let n = 0;
  while (line.charCodeAt(n) === BYTE_ORDER_MARK) n++;
  return n;
}

/**
 * Lines of a text file. Accepts '\n', '\r\n' and '\r' line endings, and removes byte-order
 * marks from the start of EVERY line, not only from the start of the text: files that each
 * begin with a BOM are often concatenated (`cat a.gb b.gb`, `copy /b`), and `TextDecoder`
 * strips only the first one, so the others would hide the LOCUS or '>' line of the next record.
 * A byte-order mark is never data. Lines are otherwise returned unchanged.
 */
export function splitTextLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const marks = leadingByteOrderMarks(lines[i]);
    if (marks > 0) lines[i] = lines[i].slice(marks);
  }
  return lines;
}

/**
 * Append `items` to `out` one by one. Use this instead of `out.push(...items)` whenever `items`
 * can be large (lines of a block, warnings of a record): a spread passes every element as a
 * call argument, and beyond the engine's argument limit (about 125 000 in V8 with its default
 * stack; the limit depends on the engine and the stack size) the call throws a RangeError.
 */
export function appendAll<T>(out: T[], items: readonly T[]): void {
  for (const item of items) out.push(item);
}
