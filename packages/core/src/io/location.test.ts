import { describe, expect, it } from 'vitest';
import type { Range, Strand, Topology } from '../types';
import { formatLocation, parseLocation, type LocationParseResult } from './location';

/** Deterministic PRNG (mulberry32) for the property tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ok(result: LocationParseResult) {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result;
}

const seg = (start: number, end: number): Range => ({ start, end });

interface Case {
  text: string;
  L: number;
  topology?: Topology;
  segments: Range[];
  strand?: Strand;
  partialStart?: boolean;
  partialEnd?: boolean;
  /** Number of warnings expected (default 0). */
  warnings?: number;
  /** Normalized text produced by formatLocation (default: the input text). */
  formatted?: string;
}

// Every form of the INSDC location grammar (Feature Table Definition 3.4) plus the
// malformed variants found in real files. L = sequence length.
const CASES: Case[] = [
  // single bases and spans
  { text: '467', L: 1000, segments: [seg(466, 467)] },
  { text: '1', L: 1, segments: [seg(0, 1)] },
  { text: '100', L: 100, segments: [seg(99, 100)] },
  { text: '340..565', L: 1000, segments: [seg(339, 565)] },
  { text: '1..1000', L: 1000, segments: [seg(0, 1000)] },
  { text: '5..5', L: 10, segments: [seg(4, 5)], formatted: '5' },
  // fuzzy ends
  { text: '<345..500', L: 1000, segments: [seg(344, 500)], partialStart: true },
  { text: '<1..888', L: 1000, segments: [seg(0, 888)], partialStart: true },
  { text: '1..>888', L: 1000, segments: [seg(0, 888)], partialEnd: true },
  { text: '<1..>888', L: 1000, segments: [seg(0, 888)], partialStart: true, partialEnd: true },
  { text: '<5', L: 10, segments: [seg(4, 5)], partialStart: true, formatted: '<5..5' },
  { text: '>5', L: 10, segments: [seg(4, 5)], partialEnd: true, formatted: '5..>5' },
  // markers pointing into the span ('>' on the lower boundary, '<' on the upper one): the model
  // has no direction, so they are stored as fuzzy boundaries, written back as '<' / '>', and
  // the direction change is reported (review finding; Biopython keeps '>5..10' as written)
  { text: '1..<9', L: 10, segments: [seg(0, 9)], partialEnd: true, warnings: 1, formatted: '1..>9' },
  { text: '>5..10', L: 20, segments: [seg(4, 10)], partialStart: true, warnings: 1, formatted: '<5..10' },
  { text: '>5..<9', L: 20, segments: [seg(4, 9)], partialStart: true, partialEnd: true, warnings: 2, formatted: '<5..>9' },
  { text: 'complement(>3..12)', L: 20, segments: [seg(2, 12)], strand: -1, partialStart: true, warnings: 1, formatted: 'complement(<3..12)' },
  { text: 'join(>1..10,20..30)', L: 100, segments: [seg(0, 10), seg(19, 30)], partialStart: true, warnings: 1, formatted: 'join(<1..10,20..30)' },
  // inward markers on inner boundaries are dropped like any inner fuzzy marker (one warning)
  { text: 'join(1..<10,20..30)', L: 100, segments: [seg(0, 10), seg(19, 30)], warnings: 1, formatted: 'join(1..10,20..30)' },
  // a clamped boundary really lies beyond base 1: '<1' is right, nothing to report but the clamp
  { text: '>0..5', L: 10, segments: [seg(0, 5)], partialStart: true, warnings: 1, formatted: '<1..5' },
  // between-bases sites (zero-length segments at a gap position)
  { text: '123^124', L: 1000, segments: [seg(123, 123)] },
  { text: '0^1', L: 10, segments: [seg(0, 0)] },
  { text: '10^11', L: 10, segments: [seg(10, 10)] },
  { text: '1000^1', L: 1000, topology: 'circular', segments: [seg(0, 0)] },
  { text: '0^1', L: 1000, topology: 'circular', segments: [seg(0, 0)], formatted: '1000^1' },
  { text: '5^6', L: 1000, topology: 'circular', segments: [seg(5, 5)] },
  { text: '10^1', L: 10, segments: [seg(10, 10)], warnings: 1, formatted: '10^11' },
  { text: '5^8', L: 10, segments: [seg(5, 7)], warnings: 1, formatted: '6..7' },
  // uncertain positions
  { text: '102.110', L: 1000, segments: [seg(101, 110)], warnings: 1, formatted: '102..110' },
  { text: '(9.10)..(20.25)', L: 1000, segments: [seg(8, 25)], warnings: 2, formatted: '9..25' },
  { text: 'one-of(1888,1901)..2200', L: 2509, segments: [seg(1887, 2200)], warnings: 1, formatted: '1888..2200' },
  { text: '100..one-of(200,210)', L: 1000, segments: [seg(99, 200)], warnings: 1, formatted: '100..200' },
  { text: 'one-of(5,8)', L: 10, segments: [seg(4, 5)], warnings: 1, formatted: '5' },
  { text: 'one-of(1..4,6..8)', L: 10, segments: [seg(0, 4)], warnings: 1, formatted: '1..4' },
  // operators
  { text: 'complement(340..565)', L: 1000, segments: [seg(339, 565)], strand: -1 },
  { text: 'complement(<1..>50)', L: 100, segments: [seg(0, 50)], strand: -1, partialStart: true, partialEnd: true },
  { text: 'complement(34)', L: 100, segments: [seg(33, 34)], strand: -1 },
  { text: 'complement(5^6)', L: 100, segments: [seg(5, 5)], strand: -1 },
  { text: 'join(12..78,134..202)', L: 1000, segments: [seg(11, 78), seg(133, 202)] },
  { text: 'join(1..10)', L: 100, segments: [seg(0, 10)], formatted: '1..10' },
  {
    text: 'complement(join(2691..4571,4918..5163))',
    L: 6000,
    segments: [seg(2690, 4571), seg(4917, 5163)],
    strand: -1,
  },
  {
    text: 'join(complement(4918..5163),complement(2691..4571))',
    L: 6000,
    segments: [seg(2690, 4571), seg(4917, 5163)],
    strand: -1,
    formatted: 'complement(join(2691..4571,4918..5163))',
  },
  {
    text: 'complement(join(<1..10,20..>30))',
    L: 100,
    segments: [seg(0, 10), seg(19, 30)],
    strand: -1,
    partialStart: true,
    partialEnd: true,
  },
  { text: 'join(1..10,join(20..30,40..50))', L: 100, segments: [seg(0, 10), seg(19, 30), seg(39, 50)], formatted: 'join(1..10,20..30,40..50)' },
  { text: 'complement(complement(1..10))', L: 100, segments: [seg(0, 10)], formatted: '1..10' },
  { text: 'order(1..10,20..30)', L: 100, segments: [seg(0, 10), seg(19, 30)], warnings: 1, formatted: 'join(1..10,20..30)' },
  { text: 'bond(12,63)', L: 64, segments: [seg(11, 12), seg(62, 63)], warnings: 1, formatted: 'join(12,63)' },
  { text: 'join(1..10,)', L: 100, segments: [seg(0, 10)], warnings: 1, formatted: '1..10' },
  { text: 'replace(266,"c")', L: 1000, segments: [seg(265, 266)], warnings: 1, formatted: '266' },
  { text: 'JOIN(1..2,Complement(3..4))', L: 10, segments: [seg(0, 2), seg(2, 4)], warnings: 1, formatted: 'join(1..2,3..4)' },
  // whitespace and line-wrapping debris is ignored
  { text: ' join( 1..10 ,\n 20..30 ) ', L: 100, segments: [seg(0, 10), seg(19, 30)], formatted: 'join(1..10,20..30)' },
  { text: 'join(4876..502\n8,5141..5332)', L: 6000, segments: [seg(4875, 5028), seg(5140, 5332)], formatted: 'join(4876..5028,5141..5332)' },
  // remote references
  { text: 'join(1..10,J00194.1:100..202,20..30)', L: 100, segments: [seg(0, 10), seg(19, 30)], warnings: 1, formatted: 'join(1..10,20..30)' },
  {
    text: 'join(2201..2479,U18267.1:120..246,U18269.1:82..>128)',
    L: 2509,
    segments: [seg(2200, 2479)],
    warnings: 2,
    formatted: '2201..2479',
  },
  // mixed strands: majority wins (tie: first written part)
  {
    text: 'join(complement(1..10),20..30,40..50)',
    L: 100,
    segments: [seg(0, 10), seg(19, 30), seg(39, 50)],
    warnings: 1,
    formatted: 'join(1..10,20..30,40..50)',
  },
  {
    text: 'join(complement(1..10),20..30)',
    L: 100,
    segments: [seg(19, 30), seg(0, 10)],
    strand: -1,
    warnings: 1,
    formatted: 'complement(join(20..30,1..10))',
  },
  // fuzzy markers on inner boundaries cannot be represented
  { text: 'join(1..10,<20..30)', L: 100, segments: [seg(0, 10), seg(19, 30)], warnings: 1, formatted: 'join(1..10,20..30)' },
  // circular molecules: origin-spanning forms merge into one wrapping segment (end > L)
  { text: '91..10', L: 100, topology: 'circular', segments: [seg(90, 110)], formatted: 'join(91..100,1..10)' },
  { text: 'join(91..100,1..10)', L: 100, topology: 'circular', segments: [seg(90, 110)] },
  { text: 'complement(91..10)', L: 100, topology: 'circular', segments: [seg(90, 110)], strand: -1, formatted: 'complement(join(91..100,1..10))' },
  { text: 'complement(join(91..100,1..10))', L: 100, topology: 'circular', segments: [seg(90, 110)], strand: -1 },
  {
    text: 'join(complement(1..10),complement(91..100))',
    L: 100,
    topology: 'circular',
    segments: [seg(90, 110)],
    strand: -1,
    formatted: 'complement(join(91..100,1..10))',
  },
  {
    text: '<91..>10',
    L: 100,
    topology: 'circular',
    segments: [seg(90, 110)],
    partialStart: true,
    partialEnd: true,
    formatted: 'join(<91..100,1..>10)',
  },
  { text: 'join(<91..100,1..>10)', L: 100, topology: 'circular', segments: [seg(90, 110)], partialStart: true, partialEnd: true },
  // fuzzy markers at the origin junction are inner boundaries too: merged away WITH the warning
  // (review finding: they used to disappear silently)
  { text: 'join(91..>100,<1..10)', L: 100, topology: 'circular', segments: [seg(90, 110)], warnings: 1, formatted: 'join(91..100,1..10)' },
  { text: 'join(51..>60,1..10)', L: 60, topology: 'circular', segments: [seg(50, 70)], warnings: 1, formatted: 'join(51..60,1..10)' },
  { text: 'join(51..60,<1..10)', L: 60, topology: 'circular', segments: [seg(50, 70)], warnings: 1, formatted: 'join(51..60,1..10)' },
  {
    text: 'complement(join(91..>100,<1..10))',
    L: 100,
    topology: 'circular',
    segments: [seg(90, 110)],
    strand: -1,
    warnings: 1,
    formatted: 'complement(join(91..100,1..10))',
  },
  {
    text: 'join(complement(<1..10),complement(91..>100))',
    L: 100,
    topology: 'circular',
    segments: [seg(90, 110)],
    strand: -1,
    warnings: 1,
    formatted: 'complement(join(91..100,1..10))',
  },
  // an inward marker on the outer boundary of an origin-spanning feature
  { text: '>91..10', L: 100, topology: 'circular', segments: [seg(90, 110)], partialStart: true, warnings: 1, formatted: 'join(<91..100,1..10)' },
  { text: 'join(91..100,1..<10)', L: 100, topology: 'circular', segments: [seg(90, 110)], partialEnd: true, warnings: 1, formatted: 'join(91..100,1..>10)' },
  {
    text: 'join(50..60,91..100,1..10)',
    L: 100,
    topology: 'circular',
    segments: [seg(49, 60), seg(90, 110)],
  },
  { text: 'join(1..10,91..100)', L: 100, topology: 'circular', segments: [seg(0, 10), seg(90, 100)] },
  { text: 'join(91..100,1..100)', L: 100, topology: 'circular', segments: [seg(90, 100), seg(0, 100)] },
  { text: '1..100', L: 100, topology: 'circular', segments: [seg(0, 100)] },
  { text: '51..50', L: 100, topology: 'circular', segments: [seg(50, 150)], formatted: 'join(51..100,1..50)' },
  { text: '100..1', L: 100, topology: 'circular', segments: [seg(99, 101)], formatted: 'join(100,1)' },
  { text: '90..120', L: 100, topology: 'circular', segments: [seg(89, 120)], warnings: 1, formatted: 'join(90..100,1..20)' },
  { text: '90..250', L: 100, topology: 'circular', segments: [seg(89, 189)], warnings: 1, formatted: 'join(90..100,1..89)' },
  // linear molecules: start > end is read as a join over the ends, out-of-range positions clamp
  { text: '91..10', L: 100, segments: [seg(90, 100), seg(0, 10)], warnings: 1, formatted: 'join(91..100,1..10)' },
  { text: '>91..10', L: 100, segments: [seg(90, 100), seg(0, 10)], partialStart: true, warnings: 2, formatted: 'join(<91..100,1..10)' },
  {
    text: 'complement(91..10)',
    L: 100,
    segments: [seg(90, 100), seg(0, 10)],
    strand: -1,
    warnings: 1,
    formatted: 'complement(join(91..100,1..10))',
  },
  { text: 'complement(-2..492)', L: 6497, segments: [seg(0, 492)], strand: -1, partialStart: true, warnings: 1, formatted: 'complement(<1..492)' },
  { text: '0..5', L: 10, segments: [seg(0, 5)], partialStart: true, warnings: 1, formatted: '<1..5' },
  { text: '90..120', L: 100, segments: [seg(89, 100)], partialEnd: true, warnings: 1, formatted: '90..>100' },
  { text: 'join(1..10,150..160)', L: 100, segments: [seg(0, 10)], warnings: 1, formatted: '1..10' },
];

describe('parseLocation: table of INSDC forms', () => {
  for (const c of CASES) {
    const topology = c.topology ?? 'linear';
    it(`${JSON.stringify(c.text)} on ${topology} L=${c.L}`, () => {
      const r = ok(parseLocation(c.text, c.L, topology));
      expect(r.segments).toEqual(c.segments);
      expect(r.strand).toBe(c.strand ?? 1);
      expect(r.partialStart).toBe(c.partialStart ?? false);
      expect(r.partialEnd).toBe(c.partialEnd ?? false);
      expect(r.warnings).toHaveLength(c.warnings ?? 0);
      const formatted = formatLocation(r, c.L, topology);
      expect(formatted).toBe(c.formatted ?? c.text);
      // the formatted text is a fixed point
      const again = ok(parseLocation(formatted, c.L, topology));
      expect(again.segments).toEqual(r.segments);
      expect(again.strand).toBe(r.strand);
      expect(again.partialStart).toBe(r.partialStart);
      expect(again.partialEnd).toBe(r.partialEnd);
      expect(formatLocation(again, c.L, topology)).toBe(formatted);
    });
  }
});

describe('parseLocation: review regressions', () => {
  it('reports fuzzy markers lost in an origin merge exactly like other inner markers', () => {
    const merged = ok(parseLocation('join(51..>60,<1..10)', 60, 'circular'));
    const unmerged = ok(parseLocation('join(41..>50,<51..60)', 60, 'circular'));
    expect(unmerged.warnings).toEqual(['fuzzy boundary inside a multi-part location cannot be stored and was ignored']);
    expect(merged.warnings).toEqual(unmerged.warnings);
    expect(merged).toMatchObject({ segments: [seg(50, 70)], partialStart: false, partialEnd: false });
    // outer markers of the merged segment are kept and are not inner boundaries
    expect(ok(parseLocation('join(<51..60,1..>10)', 60, 'circular'))).toMatchObject({
      segments: [seg(50, 70)],
      partialStart: true,
      partialEnd: true,
      warnings: [],
    });
  });

  it('explains that a marker pointing into the span is written back with the other direction', () => {
    const lower = ok(parseLocation('>5..10', 20, 'linear'));
    expect(lower.warnings).toHaveLength(1);
    expect(lower.warnings[0]).toMatch(/'>5'.*lower boundary.*after base 5.*'<5'/);
    const upper = ok(parseLocation('1..<9', 20, 'linear'));
    expect(upper.warnings).toHaveLength(1);
    expect(upper.warnings[0]).toMatch(/'<9'.*upper boundary.*before base 9.*'>9'/);
    // on an origin-spanning segment the upper boundary is reported with its written base number
    expect(ok(parseLocation('91..<10', 100, 'circular')).warnings[0]).toMatch(/'<10'.*'>10'/);
    // outward markers, single bases and between-bases sites are not affected
    for (const text of ['<5..10', '1..>9', '<5..>9', '<5', '>5', 'complement(<3..>12)']) {
      expect(ok(parseLocation(text, 20, 'linear')).warnings).toEqual([]);
    }
  });
});

describe('parseLocation: failures', () => {
  const bad: [string, number, Topology][] = [
    ['', 100, 'linear'],
    ['   ', 100, 'linear'],
    ['foo', 100, 'linear'],
    ['join(1..10', 100, 'linear'],
    ['complement(1..10', 100, 'linear'],
    ['1..', 100, 'linear'],
    ['..5', 100, 'linear'],
    ['1...5', 100, 'linear'],
    ['gap(100)', 100, 'linear'],
    ['?..10', 100, 'linear'],
    ['1..10)', 100, 'linear'],
    ['join()', 100, 'linear'],
    ['J00194.1:100..202', 1000, 'linear'],
    ['complement(J00194.1:100..202)', 1000, 'linear'],
    ['215902..365470', 182, 'linear'],
    ['150..160', 100, 'circular'],
    ['7^5', 100, 'linear'],
    ['1..10', 0, 'linear'],
  ];
  for (const [text, L, topology] of bad) {
    it(`rejects ${JSON.stringify(text)} (L=${L}, ${topology})`, () => {
      const r = parseLocation(text, L, topology);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    });
  }

  it('rejects absurdly deep nesting instead of overflowing the stack', () => {
    const deep = 'complement('.repeat(100_000) + '1..2' + ')'.repeat(100_000);
    const r = parseLocation(deep, 10, 'linear');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nested too deeply/);
    expect(ok(parseLocation('complement('.repeat(20) + '1..2' + ')'.repeat(20), 10, 'linear')).strand).toBe(1);
  });

  it('parses a join of 20 000 parts in linear time', () => {
    const parts = Array.from({ length: 20_000 }, (_, k) => `${k * 10 + 1}..${k * 10 + 5}`);
    const t0 = performance.now();
    const r = ok(parseLocation(`join(${parts.join(',')})`, 200_000, 'linear'));
    expect(r.segments).toHaveLength(20_000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('explains why a remote-only location is unusable', () => {
    const r = parseLocation('J00194.1:100..202', 1000, 'linear');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/other entries/);
  });
});

describe('formatLocation', () => {
  it('formats single segments, strands and partial ends', () => {
    expect(formatLocation({ strand: 1, segments: [seg(0, 10)] }, 100, 'linear')).toBe('1..10');
    expect(formatLocation({ strand: 0, segments: [seg(0, 10)] }, 100, 'linear')).toBe('1..10');
    expect(formatLocation({ strand: -1, segments: [seg(0, 10)] }, 100, 'linear')).toBe('complement(1..10)');
    expect(formatLocation({ strand: 1, segments: [seg(4, 5)] }, 100, 'linear')).toBe('5');
    expect(formatLocation({ strand: 1, segments: [seg(4, 5)], partialStart: true }, 100, 'linear')).toBe('<5..5');
    expect(formatLocation({ strand: 1, segments: [seg(4, 5)], partialEnd: true }, 100, 'linear')).toBe('5..>5');
    expect(formatLocation({ strand: 1, segments: [seg(0, 100)], partialStart: true, partialEnd: true }, 100, 'linear')).toBe(
      '<1..>100',
    );
  });

  it('formats joins in top-strand order with complement outside', () => {
    const loc = { strand: -1 as const, segments: [seg(0, 10), seg(19, 30)], partialStart: true, partialEnd: true };
    expect(formatLocation(loc, 100, 'linear')).toBe('complement(join(<1..10,20..>30))');
  });

  it('formats origin-wrapping segments as join(s..L,1..e)', () => {
    expect(formatLocation({ strand: 1, segments: [seg(90, 110)] }, 100, 'circular')).toBe('join(91..100,1..10)');
    expect(formatLocation({ strand: -1, segments: [seg(90, 110)], partialStart: true, partialEnd: true }, 100, 'circular')).toBe(
      'complement(join(<91..100,1..>10))',
    );
    expect(formatLocation({ strand: 1, segments: [seg(0, 100)] }, 100, 'circular')).toBe('1..100');
    expect(formatLocation({ strand: 1, segments: [seg(50, 150)] }, 100, 'circular')).toBe('join(51..100,1..50)');
    expect(formatLocation({ strand: 1, segments: [seg(99, 101)] }, 100, 'circular')).toBe('join(100,1)');
  });

  it('normalizes segments before formatting', () => {
    expect(formatLocation({ strand: 1, segments: [seg(190, 210)] }, 100, 'circular')).toBe('join(91..100,1..10)');
    expect(formatLocation({ strand: 1, segments: [seg(-5, 120)] }, 100, 'linear')).toBe('1..100');
    expect(formatLocation({ strand: 1, segments: [seg(100, 100)] }, 100, 'circular')).toBe('100^1');
  });

  it('formats zero-length segments as between-bases sites', () => {
    expect(formatLocation({ strand: 1, segments: [seg(5, 5)] }, 100, 'linear')).toBe('5^6');
    expect(formatLocation({ strand: 1, segments: [seg(0, 0)] }, 100, 'linear')).toBe('0^1');
    expect(formatLocation({ strand: 1, segments: [seg(100, 100)] }, 100, 'linear')).toBe('100^101');
    expect(formatLocation({ strand: 1, segments: [seg(0, 0)] }, 100, 'circular')).toBe('100^1');
    expect(formatLocation({ strand: 1, segments: [seg(5, 5)], partialStart: true }, 100, 'linear')).toBe('5^6');
    expect(formatLocation({ strand: -1, segments: [seg(3, 3), seg(10, 20)] }, 100, 'linear')).toBe('complement(join(3^4,11..20))');
  });

  it('returns an empty string when there is nothing to format', () => {
    expect(formatLocation({ strand: 1, segments: [] }, 100, 'linear')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Property tests (seeded)
// ---------------------------------------------------------------------------

/** Random canonical feature location: what parseLocation would return for its own output. */
function randomLocation(next: () => number) {
  const L = 1 + Math.floor(next() * 400);
  const topology: Topology = next() < 0.5 ? 'circular' : 'linear';
  const strand: Strand = next() < 0.5 ? 1 : -1;
  const n = 1 + Math.floor(next() * 4);
  const segments: Range[] = [];
  for (let k = 0; k < n; k++) {
    const r = next();
    if (r < 0.1) {
      const gap = Math.floor(next() * (topology === 'circular' ? L : L + 1));
      segments.push({ start: gap, end: gap });
    } else {
      const start = Math.floor(next() * L);
      const maxLen = topology === 'circular' ? L : L - start;
      const len = 1 + Math.floor(next() * maxLen);
      segments.push({ start, end: start + len });
    }
  }
  // canonical: on circular molecules consecutive pieces ...L | 0... would be merged by the parser
  const canonical: Range[] = [];
  for (const s of segments) {
    const prev = canonical[canonical.length - 1];
    const merges =
      topology === 'circular' && prev !== undefined && prev.end === L && s.start === 0 && prev.end > prev.start && s.end > s.start;
    const fits = prev !== undefined && prev.end - prev.start + s.end <= L;
    if (merges && fits) canonical[canonical.length - 1] = { start: prev.start, end: L + s.end };
    else canonical.push(s);
  }
  const first = canonical[0];
  const last = canonical[canonical.length - 1];
  const partialStart = first.end > first.start && next() < 0.3;
  const partialEnd = last.end > last.start && next() < 0.3;
  return { L, topology, strand, segments: canonical, partialStart, partialEnd };
}

describe('property: parseLocation(formatLocation(x)) == x', () => {
  it('holds for 5000 seeded random canonical locations', () => {
    const next = rng(20261008);
    for (let iter = 0; iter < 5000; iter++) {
      const loc = randomLocation(next);
      const text = formatLocation(loc, loc.L, loc.topology);
      const r = parseLocation(text, loc.L, loc.topology);
      if (!r.ok) throw new Error(`${text}: ${r.error}`);
      expect({ text, segments: r.segments }).toEqual({ text, segments: loc.segments });
      expect(r.strand).toBe(loc.strand);
      expect(r.partialStart).toBe(loc.partialStart);
      expect(r.partialEnd).toBe(loc.partialEnd);
      expect(r.warnings).toEqual([]);
      // and the printed text never contains positions outside 1..L except the documented 0^1 / L^L+1 sites
      for (const m of text.matchAll(/\d+/g)) expect(Number(m[0])).toBeLessThanOrEqual(loc.L + 1);
    }
  });
});

/** Random location text drawn from the grammar, including malformed-but-tolerated forms. */
function randomLocationText(next: () => number, L: number, depth = 0): string {
  const pos = () => 1 + Math.floor(next() * L);
  const r = next();
  if (depth < 2 && r < 0.15) return `complement(${randomLocationText(next, L, depth + 1)})`;
  if (depth < 2 && r < 0.3) {
    const n = 1 + Math.floor(next() * 3);
    const parts = Array.from({ length: n }, () => randomLocationText(next, L, depth + 1));
    return `${next() < 0.8 ? 'join' : 'order'}(${parts.join(',')})`;
  }
  if (r < 0.4) return String(pos());
  if (r < 0.45) {
    const a = Math.floor(next() * (L + 1));
    return `${a}^${a + 1}`;
  }
  const a = pos();
  const b = pos();
  return `${next() < 0.2 ? '<' : ''}${a}..${next() < 0.2 ? '>' : ''}${b}`;
}

describe('property: format(parse(text)) is a normal form', () => {
  it('parse -> format -> parse is stable for 5000 seeded random location texts', () => {
    const next = rng(42);
    let parsed = 0;
    for (let iter = 0; iter < 5000; iter++) {
      const L = 1 + Math.floor(next() * 300);
      const topology: Topology = next() < 0.5 ? 'circular' : 'linear';
      const text = randomLocationText(next, L);
      const first = parseLocation(text, L, topology);
      if (!first.ok) continue;
      parsed++;
      for (const s of first.segments) {
        // every segment satisfies the coordinate conventions of types.ts
        expect(s.start).toBeGreaterThanOrEqual(0);
        expect(s.end).toBeGreaterThanOrEqual(s.start);
        if (topology === 'linear') expect(s.end).toBeLessThanOrEqual(L);
        else {
          expect(s.start).toBeLessThan(L);
          expect(s.end - s.start).toBeLessThanOrEqual(L);
        }
      }
      const formatted = formatLocation(first, L, topology);
      const second = ok(parseLocation(formatted, L, topology));
      expect({ text, formatted, segments: second.segments }).toEqual({ text, formatted, segments: first.segments });
      expect(second.strand).toBe(first.strand);
      expect(second.partialStart).toBe(first.partialStart);
      expect(second.partialEnd).toBe(first.partialEnd);
      expect(formatLocation(second, L, topology)).toBe(formatted);
    }
    expect(parsed).toBeGreaterThan(4000);
  });
});
