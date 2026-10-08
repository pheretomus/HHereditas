/**
 * Text layer of the SnapGene reader/writer: UTF-8, XML entities and escaping, HTML rich text.
 * Differential references: Node's TextDecoder/TextEncoder (WHATWG Encoding Standard) and
 * Python's html.unescape / html.parser (oracle file test/oracle/snapgene/html.json).
 */
import { describe, expect, it } from 'vitest';
import { decodeUtf8, decodeUtf8WithReplacements, encodeUtf8 } from './snapgene-binary';
import {
  HTML_ENTITY_COUNT,
  countXmlInvalidCharacters,
  decodeHtmlEntities,
  decodeXmlEntities,
  escapeXmlAttribute,
  escapeXmlText,
  htmlEntityCodePoint,
  htmlToText,
  looksLikeHtml,
  parseXml,
  plainToRichText,
  richTextToPlain,
  textToHtmlDocument,
  xmlElement,
} from './snapgene-markup';
import { Rng, loadJson } from '../../test/oracle/snapgene/testkit';

interface HtmlOracle {
  name2codepoint: Record<string, number>;
  html5: Record<string, number>;
  invalid_charrefs: Record<string, number>;
  unescape: Array<[string, string]>;
  render: Array<[string, string, string]>;
}

const htmlOracle = loadJson<HtmlOracle>('html.json');

describe('UTF-8', () => {
  const reference = new TextDecoder('utf-8');

  it('decodes ASCII, BMP and astral characters', () => {
    const text = 'ACGT β-lactamase µg 5′→3′ 🧬 naïve';
    expect(decodeUtf8(new TextEncoder().encode(text))).toBe(text);
    expect(decodeUtf8(new Uint8Array(0))).toBe('');
  });

  it('drops a leading byte order mark like TextDecoder', () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(decodeUtf8(new Uint8Array([0x41, 0xef, 0xbb, 0xbf]))).toBe('A\ufeff');
  });

  it('replaces ill-formed sequences with U+FFFD exactly like the WHATWG decoder', () => {
    const cases = [
      [0xff], [0x80], [0xc0, 0x80], [0xc2], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80],
      [0xf0, 0x90, 0x80], [0xe2, 0x82], [0x41, 0xe2, 0x82, 0x41], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xc3, 0x28], [0xef, 0xbb],
    ];
    for (const bytes of cases) expect(decodeUtf8(new Uint8Array(bytes))).toBe(reference.decode(new Uint8Array(bytes)));
  });

  it('matches TextDecoder on 3000 random byte strings (seeded)', () => {
    const rng = new Rng(1);
    for (let n = 0; n < 3000; n++) {
      const bytes = new Uint8Array(rng.int(0, 40));
      for (let i = 0; i < bytes.length; i++) {
        // Bias towards bytes that start or continue multi-byte sequences.
        bytes[i] = rng.chance(0.5) ? rng.int(0x80, 0xff) : rng.chance(0.5) ? rng.int(0xc0, 0xf7) : rng.int(0, 0x7f);
      }
      expect(decodeUtf8(bytes)).toBe(reference.decode(bytes));
    }
  });

  it('matches TextEncoder on random strings including unpaired surrogates (seeded)', () => {
    const rng = new Rng(2);
    const encoder = new TextEncoder();
    for (let n = 0; n < 3000; n++) {
      let text = '';
      for (let i = rng.int(0, 30); i > 0; i--) {
        const r = rng.next();
        text += String.fromCharCode(r < 0.4 ? rng.int(0, 0x7f) : r < 0.6 ? rng.int(0x80, 0x7ff) : r < 0.8 ? rng.int(0x800, 0xffff) : rng.int(0xd800, 0xdfff));
      }
      expect(Array.from(encodeUtf8(text))).toEqual(Array.from(encoder.encode(text)));
    }
  });

  it('round-trips long text (chunked string building)', () => {
    const text = 'αβγ🧬ACGT'.repeat(20000);
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
  });

  it('counts the ill-formed sequences it replaces; a U+FFFD encoded in the input is not counted', () => {
    expect(decodeUtf8WithReplacements(new Uint8Array([0x41, 0xb5, 0x42]))).toEqual({ text: 'A\ufffdB', replacements: 1 });
    expect(decodeUtf8WithReplacements(new Uint8Array([0xef, 0xbf, 0xbd]))).toEqual({ text: '\ufffd', replacements: 0 });
    expect(decodeUtf8WithReplacements(new Uint8Array([0xe2, 0x82]))).toEqual({ text: '\ufffd', replacements: 1 }); // truncated at the end
    expect(decodeUtf8WithReplacements(new TextEncoder().encode('µ°®'))).toEqual({ text: 'µ°®', replacements: 0 });
  });

  it('counts replacements like TextDecoder on 3000 random byte strings (seeded)', () => {
    const rng = new Rng(5);
    let checked = 0;
    for (let n = 0; n < 3000; n++) {
      const bytes = new Uint8Array(rng.int(0, 40));
      for (let i = 0; i < bytes.length; i++) bytes[i] = rng.chance(0.5) ? rng.int(0x80, 0xff) : rng.chance(0.5) ? rng.int(0xc0, 0xf7) : rng.int(0, 0x7f);
      // Skip inputs holding an encoded U+FFFD (EF BF BD; 0xEF never continues a sequence, so it always decodes as such).
      if (/\xef\xbf\xbd/.test(String.fromCharCode(...bytes))) continue;
      const text = reference.decode(bytes);
      expect(decodeUtf8WithReplacements(bytes)).toEqual({ text, replacements: [...text].filter((c) => c === '\ufffd').length });
      checked++;
    }
    expect(checked).toBeGreaterThan(2900);
  });
});

describe('XML entities and escaping', () => {
  it('decodes predefined and numeric references once', () => {
    expect(decodeXmlEntities('a &amp;amp; &lt;b&gt; &quot;q&quot; &apos;s&apos;')).toBe('a &amp; <b> "q" \'s\'');
    expect(decodeXmlEntities('x&#10;y&#x3b1;&#956;&#x1F9EC;')).toBe('x\nyαμ🧬');
    expect(decodeXmlEntities('no entities here')).toBe('no entities here');
  });

  it('leaves unknown and DOCTYPE-declared entities literal, and replaces invalid code points', () => {
    expect(decodeXmlEntities('&nbsp; &e; &AMP; &#X41;')).toBe('&nbsp; &e; &AMP; &#X41;');
    expect(decodeXmlEntities('&#0; &#xD800; &#x110000; &#99999999999999999999;')).toBe('\ufffd \ufffd \ufffd \ufffd');
  });

  it('escapes attribute values so that decoding restores them', () => {
    const rng = new Rng(3);
    const alphabet = ['a', '&', '<', '>', '"', "'", '\t', '\n', '\r', ' ', 'β', '🧬', '&amp;', '&#10;'];
    for (let n = 0; n < 500; n++) {
      let value = '';
      for (let i = rng.int(0, 20); i > 0; i--) value += rng.pick(alphabet);
      const escaped = escapeXmlAttribute(value);
      expect(escaped).not.toMatch(/[<>"\t\n\r]/);
      expect(decodeXmlEntities(escaped)).toBe(value);
      expect(decodeXmlEntities(escapeXmlText(value))).toBe(value);
    }
  });

  it('replaces characters XML cannot represent', () => {
    expect(countXmlInvalidCharacters('a\u0001b\u001fc\ufffe\ud800')).toBe(4);
    expect(countXmlInvalidCharacters('ok\t\n\r🧬')).toBe(0);
    expect(escapeXmlAttribute('a\u0001b')).toBe('a\ufffdb');
    expect(escapeXmlText('\ud83e')).toBe('\ufffd');
    expect(escapeXmlText('🧬')).toBe('🧬');
  });

  it('serializes elements with escaped attributes and optional content', () => {
    expect(xmlElement('V', [['text', 'a<b & "c"'], ['int', undefined]])).toBe('<V text="a&lt;b &amp; &quot;c&quot;"/>');
    expect(xmlElement('Q', [['name', 'note']], '<V/>')).toBe('<Q name="note"><V/></Q>');
  });
});

describe('XML documents', () => {
  it('builds an element tree with decoded attributes, text and CDATA', () => {
    const parsed = parseXml('<?xml version="1.0"?><R a="x &amp; y" b="&#10;"><!-- c --><C>t1<![CDATA[a &amp; <b>]]>t2</C><D/><D k=""/></R>');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const root = parsed.root;
    expect(root.name).toBe('R');
    expect(root.attributes.get('a')).toBe('x & y');
    expect(root.attributes.get('b')).toBe('\n');
    expect(root.children.map((c) => c.name)).toEqual(['C', 'D', 'D']);
    expect(root.children[0].text).toBe('t1a &amp; <b>t2');
    expect(root.children[2].attributes.get('k')).toBe('');
  });

  it('reports malformed documents instead of throwing', () => {
    for (const bad of ['', '<a><b></a>', '<Features><Feature name="x"', 'garbage < > &', '<a x="1" x="2"/>', '<__proto__/>', '<a><constructor/></a>']) {
      const parsed = parseXml(bad);
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });

  it('does not expand entities declared in a DOCTYPE', () => {
    const parsed = parseXml('<!DOCTYPE x [<!ENTITY e "EEEEEEEEEE"><!ENTITY f "&e;&e;&e;&e;">]><x a="&f;">&f;</x>');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.root.attributes.get('a')).toBe('&f;');
      expect(parsed.root.text).toBe('&f;');
    }
  });
});

describe('HTML character references (vs Python html module)', () => {
  it('knows exactly the 252 HTML 4.01 entity names (+ apos) with their current code points', () => {
    const names = Object.keys(htmlOracle.name2codepoint);
    expect(names.length).toBe(252);
    expect(HTML_ENTITY_COUNT).toBe(253);
    for (const name of names) expect(htmlEntityCodePoint(name), name).toBe(htmlOracle.html5[name]);
    expect(htmlEntityCodePoint('apos')).toBe(39);
    // HTML5 changed only these two code points relative to HTML 4.01:
    const changed = names.filter((n) => htmlOracle.name2codepoint[n] !== htmlOracle.html5[n]).sort();
    expect(changed).toEqual(['lang', 'rang']);
  });

  it('replaces numeric references like Python (Windows-1252 table, invalid code points)', () => {
    for (const [code, replacement] of Object.entries(htmlOracle.invalid_charrefs)) {
      expect(decodeHtmlEntities(`&#${code};`), code).toBe(String.fromCodePoint(replacement));
    }
    expect(decodeHtmlEntities('&#1;&#11;&#127;&#xFDD0;&#xFFFE;&#x10FFFF;')).toBe('');
    expect(decodeHtmlEntities('&#9;&#10;&#12;&#13;')).toBe('\t\n\f\r');
  });

  it('agrees with html.unescape on 300 random strings', () => {
    for (const [input, expected] of htmlOracle.unescape) expect(decodeHtmlEntities(input), input).toBe(expected);
  });
});

describe('SnapGene rich text', () => {
  it('detects HTML only when there is real markup', () => {
    for (const html of ['<html><body>x</body></html>', 'a<br>b', '<!--StartFragment-->x', '<B>bold</B>', '<span style="x">y</span>', '<p/>', '<!DOCTYPE html>']) {
      expect(looksLikeHtml(html), html).toBe(true);
    }
    for (const plain of ['FeatureC', '<unknown', "5' <- 3'", 'x > y', '<5kb>', 'a<b', '<bla>', '<i', '&amp;']) expect(looksLikeHtml(plain), plain).toBe(false);
  });

  it('renders the HTML found in real SnapGene files', () => {
    // linebreak_in_qualifier_text.dna
    expect(htmlToText('<html><body><!--StartFragment-->Origin of transference region of RP4 plasmid<!--EndFragment-->\n\n</body></html>', 'line')).toBe(
      'Origin of transference region of RP4 plasmid',
    );
    // pIB2-SEC13-mEGFP.dna (SnapGene Viewer sample): description and comments
    expect(htmlToText('<html><body><b>Welcome to SnapGene Viewer!</b><div><b><br></b></div><div>This sample file is available in the Help menu.</div></body></html>', 'line')).toBe(
      'Welcome to SnapGene Viewer! This sample file is available in the Help menu.',
    );
    expect(
      htmlToText(
        '<html><body>Sequence view shows:<div><br></div><div>-- an intron</div><div>&nbsp;&nbsp; &nbsp; &nbsp; Val at position 1a</div><div><br></div><div>Last.</div></body></html>',
        'block',
      ),
    ).toBe('Sequence view shows:\n\n-- an intron\nVal at position 1a\n\nLast.');
    expect(htmlToText('<html><body><i>aph(3\')-Ia</i></body></html>', 'line')).toBe("aph(3')-Ia");
    expect(htmlToText('<html><body>a &amp;amp; b</body></html>', 'line')).toBe('a &amp; b');
  });

  it('drops non-rendered content and keeps line structure in block layout', () => {
    expect(htmlToText('<html><head><style>p { margin: 0 }</style><title>t</title></head><body><p>one</p><p>two</p></body></html>', 'block')).toBe('one\ntwo');
    expect(htmlToText('a<br>b<br><br>c', 'block')).toBe('a\nb\n\nc');
    expect(htmlToText('a<br><div>b</div>', 'block')).toBe('a\nb');
    expect(htmlToText('x&#10;y', 'block')).toBe('x y');
    expect(htmlToText('<style>unclosed', 'line')).toBe('');
    expect(htmlToText('<!-- unterminated', 'line')).toBe('');
    expect(htmlToText('a < b and c > d <b>e</b>', 'line')).toBe('a < b and c > d e');
  });

  it('agrees with an html.parser-based rendering on 400 generated rich-text values', () => {
    for (const [input, line, block] of htmlOracle.render) {
      expect(richTextToPlain(input, 'line'), input).toBe(line);
      expect(richTextToPlain(input, 'block'), input).toBe(block);
    }
  });

  it('treats plain values like Biopython (line breaks become spaces, ends trimmed)', () => {
    expect(richTextToPlain('  a\r\nb\rc\nd  ', 'line')).toBe('a b c d');
    expect(richTextToPlain('a  b', 'line')).toBe('a  b');
    expect(richTextToPlain('  a\r\nb\n', 'block')).toBe('a\nb');
    expect(richTextToPlain('<unknown', 'line')).toBe('<unknown');
  });

  it('encodes text so that it reads back unchanged', () => {
    const rng = new Rng(4);
    const vocabulary = ['A&B', '<5kb>', 'x>y', '"q"', "it's", 'β', '🧬', '<b>bold</b>', '&amp;', '<!-- c -->', '<br>', 'plain', '&#10;'];
    for (let n = 0; n < 500; n++) {
      const words: string[] = [];
      for (let i = rng.int(1, 6); i > 0; i--) words.push(rng.pick(vocabulary));
      const text = words.join(' ');
      expect(richTextToPlain(plainToRichText(text), 'line'), text).toBe(text);
      const lines = `${text}\n${words.reverse().join(' ')}`;
      expect(richTextToPlain(textToHtmlDocument(lines), 'block'), lines).toBe(lines);
    }
    expect(plainToRichText('plain & simple')).toBe('plain & simple');
    expect(plainToRichText('has <b>markup</b>')).toBe('<html><body>has &lt;b&gt;markup&lt;/b&gt;</body></html>');
  });

  it('detects HTML comments exactly like the regular expression /<!--[\\s\\S]*?-->/ (seeded)', () => {
    const comment = /<!--[\s\S]*?-->/;
    const rng = new Rng(6);
    // No letters that could spell an HTML element name: only a comment can make these values HTML.
    const pieces = ['<', '!', '-', '-', '>', '<!--', '-->', 'x', '1', '\n'];
    for (let n = 0; n < 5000; n++) {
      let value = '';
      for (let i = rng.int(0, 14); i > 0; i--) value += rng.pick(pieces);
      expect(looksLikeHtml(value), JSON.stringify(value)).toBe(comment.test(value));
    }
    for (const value of ['<!---->', '<!-- x -->', 'a<!--b-->c']) expect(looksLikeHtml(value), value).toBe(true);
    for (const value of ['<!-->', '<!--->', '-->', '--><!--', '<!-- unterminated']) expect(looksLikeHtml(value), value).toBe(false);
  });

  it('detects comments in linear time ("<!--" x 150 000 without "-->")', () => {
    const started = performance.now();
    expect(looksLikeHtml('<!--'.repeat(150_000))).toBe(false);
    expect(looksLikeHtml(`${'<!--'.repeat(150_000)}-->`)).toBe(true);
    expect(richTextToPlain('<!--'.repeat(150_000), 'line')).toBe('<!--'.repeat(150_000));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('trims leading and trailing blank lines in linear time (block layout)', () => {
    const started = performance.now();
    expect(htmlToText(`<html><body>${'<br>'.repeat(200_000)}text${'<br>'.repeat(200_000)}</body></html>`, 'block')).toBe('text');
    expect(htmlToText(`${'<p></p>'.repeat(100_000)}a<br><br>b${'<div></div>'.repeat(100_000)}`, 'block')).toBe('a\n\nb');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('stays fast on hostile input (no quadratic regex backtracking)', () => {
    const hostile = `<html><body>${'<a '.repeat(50000)}${'<head>'.repeat(20000)}${'<!--'.repeat(20000)}</body></html>`;
    const started = Date.now();
    htmlToText(hostile, 'line');
    looksLikeHtml(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
