/**
 * Feature colours stored in GenBank files by ApE ("A plasmid Editor", M. Wayne Davis):
 * `/ApEinfo_fwdcolor`, `/ApEinfo_revcolor` and `/ApEinfo_graphicformat` qualifiers.
 * The same qualifiers are read and written by SnapGene, Benchling and Geneious, so they are
 * the de-facto standard way to keep colours in a GenBank file.
 *
 * ApE is a Tcl/Tk program and writes either hex colours (`#85dae9`) or Tk colour names
 * (`cyan`, `pink`, `light blue`). Colours are normalized to lower-case `#rrggbb`.
 */

/**
 * CSS Color Module Level 4, section 6.1 "Named Colors" (148 names, W3C Candidate
 * Recommendation, https://www.w3.org/TR/css-color-4/#named-colors); table generated from
 * `@csstools/color-helpers` `namedColors`. Tk 8.6 uses the same RGB values for the four
 * names where X11 and the web used to differ (gray/grey, green, maroon, purple) since
 * TIP #403 "Web Colors for Tk" (https://core.tcl-lang.org/tips/doc/trunk/tip/403.md), so
 * this table also resolves the names written by current ApE versions.
 */
const NAMED_COLORS: Readonly<Record<string, string>> = Object.freeze({
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4', azure: '#f0ffff',
  beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000', blanchedalmond: '#ffebcd', blue: '#0000ff',
  blueviolet: '#8a2be2', brown: '#a52a2a', burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00',
  chocolate: '#d2691e', coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b', darkgray: '#a9a9a9',
  darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b', darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000',
  darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b', darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3', deeppink: '#ff1493',
  deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1e90ff', firebrick: '#b22222',
  floralwhite: '#fffaf0', forestgreen: '#228b22', fuchsia: '#ff00ff', gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520', gray: '#808080', green: '#008000',
  greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080',
  lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3', lightgreen: '#90ee90',
  lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a', lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899', lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6', magenta: '#ff00ff',
  maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3',
  mediumpurple: '#9370db', mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc', mediumvioletred: '#c71585',
  midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
  navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23',
  orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98',
  paleturquoise: '#afeeee', palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9',
  peru: '#cd853f', pink: '#ffc0cb', plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080',
  rebeccapurple: '#663399', red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1',
  saddlebrown: '#8b4513', salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee',
  sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090',
  slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c',
  teal: '#008080', thistle: '#d8bfd8', tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee',
  wheat: '#f5deb3', white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
});

const HEX_DIGITS = /^[0-9a-f]+$/;

/**
 * Normalize a colour written in a GenBank qualifier to lower-case `#rrggbb`.
 *
 * Accepts `#rgb` (CSS: each digit doubled), `#rrggbb`, `#rgba` / `#rrggbbaa` (alpha
 * dropped), the Tk/X11 forms `#rrrgggbbb` and `#rrrrggggbbbb` (most significant 8 bits
 * of each channel kept), a bare 6-digit hex value, and CSS / Tk colour names
 * (case-insensitive, spaces ignored: `Light Blue` = `lightblue`).
 * Surrounding quotes and whitespace are ignored. Returns undefined for anything else.
 */
export function normalizeColor(value: string): string | undefined {
  let v = value.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
  if (v === '') return undefined;
  const name = v.replace(/\s+/g, '');
  if (Object.hasOwn(NAMED_COLORS, name)) return NAMED_COLORS[name];
  if (v.startsWith('#')) v = v.slice(1);
  else if (v.length !== 6) return undefined;
  if (!HEX_DIGITS.test(v)) return undefined;
  switch (v.length) {
    case 3:
    case 4:
      return '#' + v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    case 6:
      return '#' + v;
    case 8:
      return '#' + v.slice(0, 6);
    case 9:
      return '#' + v.slice(0, 2) + v.slice(3, 5) + v.slice(6, 8);
    case 12:
      return '#' + v.slice(0, 2) + v.slice(4, 6) + v.slice(8, 10);
    default:
      return undefined;
  }
}
