/**
 * Markup helpers for the SnapGene XML packets:
 *  - a small, immutable XML element tree built with fast-xml-parser,
 *  - XML entity decoding and escaping,
 *  - conversion between plain text and the HTML "rich text" SnapGene stores in many values
 *    (e.g. `<V text="&lt;html&gt;&lt;body&gt;promoter for T7&lt;/body&gt;&lt;/html&gt;"/>`).
 *
 * Entity handling is done here rather than by fast-xml-parser (which is run with
 * `processEntities: false`) so that every value is decoded exactly once, numeric character
 * references (`&#10;`, `&#x3b1;`) are honoured, CDATA stays literal, and entities declared
 * in a DOCTYPE are never expanded (no entity-expansion attacks from untrusted files).
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** An XML element with entity-decoded attribute values and text. */
export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Character data directly inside this element (text and CDATA, concatenated, decoded). */
  readonly text: string;
}

/** Outcome of {@link parseXml}: the root element, or a description of why parsing failed. */
export type XmlParseOutcome = { ok: true; root: XmlElement } | { ok: false; error: string };

const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  cdataPropName: '#cdata',
} as const;

const TEXT_NODE = '#text';
const CDATA_NODE = '#cdata';
const ATTRIBUTES_KEY = ':@';

type FxpNode = Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The tag name of a fast-xml-parser `preserveOrder` node (its only key besides `:@`). */
function nodeName(node: FxpNode): string | undefined {
  for (const key of Object.keys(node)) if (key !== ATTRIBUTES_KEY) return key;
  return undefined;
}

function cdataText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content as FxpNode[]) {
    if (part && typeof part === 'object' && typeof part[TEXT_NODE] === 'string') text += part[TEXT_NODE];
  }
  return text; // CDATA is literal: no entity decoding
}

function convertElement(name: string, node: FxpNode): XmlElement {
  const attributes = new Map<string, string>();
  const rawAttributes = node[ATTRIBUTES_KEY];
  if (rawAttributes && typeof rawAttributes === 'object') {
    for (const [key, value] of Object.entries(rawAttributes as Record<string, unknown>)) {
      if (typeof value === 'string') attributes.set(key, decodeXmlEntities(value));
    }
  }
  const children: XmlElement[] = [];
  let text = '';
  const content = node[name];
  if (Array.isArray(content)) {
    for (const child of content as FxpNode[]) {
      if (!child || typeof child !== 'object') continue;
      const childName = nodeName(child);
      if (childName === TEXT_NODE) text += decodeXmlEntities(String(child[TEXT_NODE]));
      else if (childName === CDATA_NODE) text += cdataText(child[CDATA_NODE]);
      else if (childName !== undefined) children.push(convertElement(childName, child));
    }
  }
  return { name, attributes, children, text };
}

/**
 * Parse an XML document and return its root element. The document is first checked for
 * well-formedness; malformed input yields `{ ok: false }` with the validator's message
 * (never an exception).
 */
export function parseXml(source: string): XmlParseOutcome {
  try {
    const validation = XMLValidator.validate(source);
    if (validation !== true) {
      const { msg, line, col } = validation.err;
      const where = col === undefined ? `line ${line}` : `line ${line}, column ${col}`;
      return { ok: false, error: `${msg} (${where})` };
    }
    const nodes: unknown = new XMLParser(PARSER_OPTIONS).parse(source);
    if (Array.isArray(nodes)) {
      for (const node of nodes as FxpNode[]) {
        if (!node || typeof node !== 'object') continue;
        const name = nodeName(node);
        if (name !== undefined && name !== TEXT_NODE && name !== CDATA_NODE) return { ok: true, root: convertElement(name, node) };
      }
    }
    return { ok: false, error: 'the document has no root element' };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Direct children of `element` with the given tag name, in document order. */
export function childElements(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const REPLACEMENT = '\ufffd';

/** The five entities predefined by XML 1.0 (W3C XML 1.0, section 4.6). */
const XML_PREDEFINED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const XML_ENTITY = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;

/** A Unicode scalar value as a string, or U+FFFD for 0, surrogates and values above U+10FFFF. */
function scalarToString(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return REPLACEMENT;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return REPLACEMENT;
  return String.fromCodePoint(codePoint);
}

/**
 * Decode XML entity and character references in one pass: the five predefined entities
 * and `&#N;` / `&#xH;`. Anything else (e.g. `&nbsp;`, or entities declared in a DOCTYPE)
 * is left as literal text.
 */
export function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(XML_ENTITY, (_whole, hexDigits: string | undefined, decimalDigits: string | undefined, name: string | undefined) => {
    if (name !== undefined) return XML_PREDEFINED_ENTITIES[name];
    return scalarToString(hexDigits !== undefined ? Number.parseInt(hexDigits, 16) : Number.parseInt(decimalDigits ?? '', 10));
  });
}

/**
 * Character entity references of HTML 4.01 (W3C Recommendation, 1999, chapter 24: 96 Latin-1,
 * 124 symbol and Greek, 32 special entities = 252 names) plus `apos` (XML / HTML5), with the
 * code points of the current HTML Living Standard, which changed only `lang` and `rang`
 * (U+2329/U+232A -> U+27E8/U+27E9). Same names as Python's `html.entities.name2codepoint`
 * and same code points as its `html5` table, which a test compares against.
 */
const HTML_ENTITIES: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  // HTML 4.01 section 24.2: Latin-1 entities, code points 160..255 in order.
  const latin1 =
    'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
    'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
    'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
  latin1.split(' ').forEach((name, i) => map.set(name, 160 + i));
  // HTML 4.01 section 24.3 (symbols, mathematical symbols, Greek letters) and 24.4 (special).
  const others =
    'fnof:402 Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 ' +
    'Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 ' +
    'mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 ' +
    'bull:8226 hellip:8230 prime:8242 Prime:8243 oline:8254 frasl:8260 weierp:8472 image:8465 real:8476 trade:8482 alefsym:8501 ' +
    'larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 ' +
    'forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 ' +
    'and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 ' +
    'oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:10216 rang:10217 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830 ' +
    'quot:34 amp:38 lt:60 gt:62 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 circ:710 tilde:732 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ' +
    'ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 permil:8240 lsaquo:8249 rsaquo:8250 euro:8364 apos:39';
  for (const entry of others.split(' ')) {
    const [name, codePoint] = entry.split(':');
    map.set(name, Number(codePoint));
  }
  return map;
})();

/** Number of named entities known to {@link decodeHtmlEntities} (exported for tests). */
export const HTML_ENTITY_COUNT = HTML_ENTITIES.size;

/** Look up an HTML 4.01 entity name (exported for tests). */
export function htmlEntityCodePoint(name: string): number | undefined {
  return HTML_ENTITIES.get(name);
}

/**
 * Numeric character references that HTML parsers replace: NUL and CR, and 0x80-0x9F, which
 * are reinterpreted as Windows-1252 (WHATWG HTML Living Standard, "numeric character reference
 * end state" table; identical to `_invalid_charrefs` in Python's `html` module). Entries
 * mapping a code point to itself are C1 controls with no Windows-1252 meaning.
 */
const REPLACED_CHARACTER_REFERENCES: ReadonlyMap<number, number> = new Map([
  [0x00, 0xfffd], [0x0d, 0x0d], [0x80, 0x20ac], [0x81, 0x81], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e],
  [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039],
  [0x8c, 0x0152], [0x8d, 0x8d], [0x8e, 0x017d], [0x8f, 0x8f], [0x90, 0x90], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc], [0x99, 0x2122],
  [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9d, 0x9d], [0x9e, 0x017e], [0x9f, 0x0178],
]);

/**
 * Code points that numeric references may not produce in rendered text: C0/C1 controls other
 * than TAB, LF, FF, CR, plus Unicode noncharacters (U+FDD0-U+FDEF and U+xFFFE/U+xFFFF). They are
 * dropped, as Python's `html.unescape` does (its `_invalid_codepoints`).
 */
function isDroppedCodePoint(cp: number): boolean {
  return (
    (cp >= 0x01 && cp <= 0x08) || cp === 0x0b || (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe
  );
}

const HTML_ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*));/g;

/**
 * Decode HTML character references in one pass: the HTML 4.01 named entities (plus `&apos;`)
 * and numeric references, which follow Python's `html.unescape` (Windows-1252 remapping of
 * 0x80-0x9F, U+FFFD for NUL, surrogates and values above U+10FFFF, control characters and
 * noncharacters dropped). Unknown names and references without a terminating semicolon are
 * left as literal text.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(HTML_ENTITY, (whole, hexDigits: string | undefined, decimalDigits: string | undefined, name: string | undefined) => {
    if (name !== undefined) {
      const codePoint = HTML_ENTITIES.get(name);
      return codePoint === undefined ? whole : String.fromCodePoint(codePoint);
    }
    const value = hexDigits !== undefined ? Number.parseInt(hexDigits, 16) : Number.parseInt(decimalDigits ?? '', 10);
    const replaced = REPLACED_CHARACTER_REFERENCES.get(value);
    if (replaced !== undefined) return String.fromCodePoint(replaced);
    if (!(value <= 0x10ffff) || (value >= 0xd800 && value <= 0xdfff)) return REPLACEMENT;
    return isDroppedCodePoint(value) ? '' : String.fromCodePoint(value);
  });
}

// ---------------------------------------------------------------------------
// Escaping (writer side)
// ---------------------------------------------------------------------------

/**
 * Finds the characters that may not appear in an XML 1.0 document at all, not even as
 * character references (W3C XML 1.0, production [2] Char): C0 controls other than TAB/LF/CR,
 * U+FFFE/U+FFFF and unpaired surrogates. Valid surrogate pairs are matched first (and kept
 * by the callers) so that no lookbehind is needed (unsupported by older WebKit webviews).
 */
const XML_CHARACTER_SCAN = /[\ud800-\udbff][\udc00-\udfff]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/g;

/** Number of characters in `text` that cannot be represented in XML 1.0 (they are written as U+FFFD). */
export function countXmlInvalidCharacters(text: string): number {
  let count = 0;
  for (const match of text.matchAll(XML_CHARACTER_SCAN)) if (match[0].length === 1) count++;
  return count;
}

function replaceXmlInvalid(text: string): string {
  return text.replace(XML_CHARACTER_SCAN, (match) => (match.length === 2 ? match : REPLACEMENT));
}

/**
 * Escape a string for use inside a double-quoted XML attribute value. Tabs and line breaks
 * become character references so that XML attribute-value normalisation keeps them.
 */
export function escapeXmlAttribute(value: string): string {
  return replaceXmlInvalid(value).replace(/[&<>"\t\n\r]/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\t':
        return '&#9;';
      case '\n':
        return '&#10;';
      default:
        return '&#13;';
    }
  });
}

/** Escape a string for use as XML character data. Carriage returns become `&#13;` so they survive line-end normalisation. */
export function escapeXmlText(value: string): string {
  return replaceXmlInvalid(value).replace(/[&<>\r]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&#13;'));
}

/**
 * Serialize one XML element. Attributes whose value is undefined are omitted; `content`
 * is already-serialized markup (undefined gives a self-closing tag).
 */
export function xmlElement(name: string, attributes: ReadonlyArray<readonly [string, string | undefined]>, content?: string): string {
  let out = `<${name}`;
  for (const [key, value] of attributes) if (value !== undefined) out += ` ${key}="${escapeXmlAttribute(value)}"`;
  return content === undefined ? `${out}/>` : `${out}>${content}</${name}>`;
}

// ---------------------------------------------------------------------------
// SnapGene rich text (HTML) <-> plain text
// ---------------------------------------------------------------------------

/**
 * How a value is laid out once converted to plain text:
 *  - 'line':  one line; every line break becomes a space (qualifiers, names, descriptions).
 *  - 'block': line breaks are kept (`\n`), e.g. for free-text comments.
 */
export type TextLayout = 'line' | 'block';

// The tag patterns below exclude '<' inside a tag so that matching stays linear in the input
// length even for hostile input (a '>' inside a quoted attribute value is not supported).
/** Elements whose start or end tag ends a line when HTML is rendered. */
const BLOCK_TAG = /<\/?(?:p|div|li|tr|h[1-6]|ul|ol|dl|dt|dd|table|blockquote|pre|hr|center|address)\b[^<>]*>/gi;
const BREAK_TAG = /<br\b[^<>]*>/gi;
/** Any other tag, declaration or processing instruction (as in HTML, `<` must be followed by a letter, '/', '!' or '?'). */
const ANY_TAG = /<[A-Za-z/!?][^<>]*>/g;
/** Comments; an unterminated comment runs to the end. */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
/** Elements whose content is not rendered; an unclosed one runs to the end. */
const NON_RENDERED = /<(head|style|script|title)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
/** Marks a "soft" line break (block boundary) while converting; adjacent soft breaks merge. */
const SOFT_BREAK = '\u0001';
/** Marks a `<br>` while converting (kept apart from whitespace, which collapses). */
const HARD_BREAK = '\u0002';

/**
 * Markup that identifies a value as HTML (besides comments, see {@link looksLikeHtml}): a DOCTYPE,
 * or a start/end tag of a common HTML element. SnapGene wraps rich text in
 * `<html><body>...</body></html>`; plain values (e.g. `FeatureC`, `<unknown` or `5' <- 3'`) do not
 * match. Each attempt stops at the next '<' or '>', so matching is linear in the value's length.
 */
const HTML_MARKUP =
  /<!doctype\s+html\b|<\/?(?:html|head|body|qt|p|br|div|span|font|b|i|u|s|em|strong|sub|sup|small|big|a|ul|ol|li|table|tr|td|th|h[1-6]|pre|code|tt|blockquote|hr|img|center)(?:\s[^<>]*)?\/?>/i;

/**
 * True if `value` contains a complete HTML comment: "<!--" followed, after it, by "-->" (the
 * strings the regular expression /<!--[\s\S]*?-->/ matches). Found with two linear searches,
 * because that regular expression rescans to the end of the value from every unterminated
 * "<!--" (quadratic time on e.g. "<!--" repeated 150 000 times).
 */
function containsHtmlComment(value: string): boolean {
  const open = value.indexOf('<!--');
  return open >= 0 && value.indexOf('-->', open + 4) >= 0;
}

/** True if `value` contains HTML markup and is therefore treated as SnapGene rich text. Linear time. */
export function looksLikeHtml(value: string): boolean {
  return value.includes('<') && (containsHtmlComment(value) || HTML_MARKUP.test(value));
}

function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Plain (non-HTML) text: 'line' turns every line break into one space, exactly like
 * Biopython's SnapGene reader; 'block' only normalises CR/CRLF to LF. Both trim the ends.
 */
function layoutPlainText(text: string, layout: TextLayout): string {
  return (layout === 'line' ? text.replace(/\r\n|\r|\n/g, ' ') : normalizeLineBreaks(text)).trim();
}

/**
 * Render SnapGene HTML rich text as plain text: comments and non-rendered elements are
 * removed, source whitespace collapses as in a browser, `<br>` and block elements become
 * line breaks ('block') or spaces ('line'), remaining tags are dropped and character
 * references are decoded. Non-breaking spaces become ordinary spaces.
 */
export function htmlToText(html: string, layout: TextLayout): string {
  let text = html.replace(/[\u0001\u0002]/g, '').replace(COMMENT, '').replace(NON_RENDERED, ' ');
  text = text.replace(BREAK_TAG, HARD_BREAK).replace(BLOCK_TAG, SOFT_BREAK).replace(ANY_TAG, '');
  // Whitespace (including whitespace written as character references) collapses; NBSP renders as a space.
  text = decodeHtmlEntities(text).replace(/[ \t\n\r\f]+/g, ' ').replace(/\u00a0/g, ' ');
  if (layout === 'line') return text.replace(/[\s\u0001\u0002]+/g, ' ').trim();
  // A block boundary starts a new line unless the text is already at the start of a line:
  // merge runs of boundaries, drop those at a line start, turn the rest into line breaks.
  text = text
    .replace(/\u0002/g, '\n')
    .replace(/\u0001(?:[ \t]*\u0001)*/g, SOFT_BREAK)
    .replace(/(^|\n)[ \t]*\u0001/g, '$1')
    .replace(/\u0001/g, '\n');
  const lines = text.split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim());
  // Drop leading and trailing blank lines (by index: repeated shift() would be quadratic).
  let first = 0;
  while (first < lines.length && lines[first] === '') first++;
  let end = lines.length;
  while (end > first && lines[end - 1] === '') end--;
  return lines.slice(first, end).join('\n');
}

/**
 * Convert a SnapGene text value to plain text. HTML rich text is rendered with
 * {@link htmlToText}; plain values only have their line breaks normalised ('line': each
 * line break becomes one space, as Biopython does) and are trimmed.
 */
export function richTextToPlain(value: string, layout: TextLayout): string {
  return looksLikeHtml(value) ? htmlToText(value, layout) : layoutPlainText(value, layout);
}

/** Escape text for inclusion in HTML (before the XML-level escaping applied by the serializer). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;'));
}

/**
 * Plain text as a SnapGene rich-text document: `<html><body>...</body></html>` with HTML
 * escaping and `<br>` for line breaks. {@link htmlToText} reads it back to the same text
 * (for text without runs of spaces or leading/trailing whitespace).
 */
export function textToHtmlDocument(text: string): string {
  return `<html><body>${escapeHtml(normalizeLineBreaks(text)).replace(/\n/g, '<br>')}</body></html>`;
}

/**
 * Encode a plain-text value for a SnapGene XML field. Values are written as plain text
 * (which SnapGene and Biopython both read verbatim) unless they contain something that
 * {@link richTextToPlain} would take for HTML markup; those are written with
 * {@link textToHtmlDocument}, so that reading them back yields the original text.
 */
export function plainToRichText(text: string): string {
  return looksLikeHtml(text) ? textToHtmlDocument(text) : text;
}
