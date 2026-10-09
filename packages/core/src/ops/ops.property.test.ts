/**
 * Property tests for the ops module with a seeded PRNG: thousands of random records (1-300 bp,
 * linear and circular, random multi-segment / origin-crossing / zero-length / both-strand
 * features, IUPAC bases, sticky ends) per operation.
 *
 * Every case checks: (d) every output range is normalized (types.ts) and ids are unique;
 * (e) inputs are deep-frozen (any write throws), unchanged afterwards, and share no object with
 * the output; plus operation-specific properties, most importantly agreement with the brute-force
 * token model of test-helpers.ts, which tracks every base individually and is independent of the
 * arithmetic in remap.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FragmentEnds, Range, SeqRecord, Topology } from '../types';
import { reverseComplement } from '../seq/alphabet';
import { featureSequence } from '../seq/features';
import { mod } from '../seq/range';
import { translateFeature } from '../seq/translate';
import { deleteRange, insertBases, replaceRange } from './edit';
import { planEdit, remapFeatures, remapGap, remapRange } from './remap';
import type { SequenceEdit } from './remap';
import { concatRecords, extractRange, reverseComplementRecord, rotateOrigin, setTopology } from './transform';
import { addFeature, addPrimer, removeFeature, removePrimer, updateFeature, updatePrimer } from './crud';
import {
  INSERTED_TOKEN,
  Rng,
  contiguousRuns,
  deepFreeze,
  modelCodonStart,
  modelFeatureEdit,
  modelLayout,
  modelQualifiers,
  randomBases,
  edgePosition,
  edgeRange,
  ligatableParts,
  randomFeature,
  randomRange,
  randomRecord,
  recordProblems,
  segmentPositions,
  segmentTokens,
  sharedObjectCount,
  withoutTranslation,
  writtenParts,
} from './test-helpers';
import type { ModelBaseMap, ModelEdit, RandomRecordOptions } from './test-helpers';

const CASES = 2500;

/**
 * Generator options for the property tests: besides single segments, contiguous joins (adjacent
 * segments, often split at the origin) and position-dependent qualifiers (/codon_start,
 * /transl_except, /anticodon, /rpt_unit_range, /tag_peptide, /translation).
 */
const RICH: RandomRecordOptions = { joins: 0.3, positional: 0.5 };

/** Run `body` on `count` seeded cases; failures report the case index for reproduction. */
function forCases(seed: number, count: number, body: (rng: Rng, i: number) => void): void {
  const rng = new Rng(seed);
  for (let i = 0; i < count; i++) {
    try {
      body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`case #${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

/** Common checks: frozen input unchanged, no shared objects, valid output. */
function checkPurity(input: unknown, snapshot: string, output: SeqRecord): void {
  expect(JSON.stringify(input)).toBe(snapshot);
  expect(sharedObjectCount(input, output)).toBe(0);
  expect(recordProblems(output)).toEqual([]);
}

function labelOf(f: Feature): string {
  return f.qualifiers.find((q) => q.key === 'label')?.value ?? f.id;
}

/** Everything about a feature except its coordinates. */
function nonPositional(f: Feature): unknown {
  const { segments: _segments, ...rest } = f;
  return rest;
}

/** Everything about a feature except its coordinates and qualifiers. */
function otherFields(f: Feature): unknown {
  const { segments: _segments, qualifiers: _qualifiers, ...rest } = f;
  return rest;
}

/**
 * The protein of a feature as seq/translate.ts reads it (/codon_start and /transl_except applied),
 * or undefined when it cannot be translated (random features often carry an off-frame /transl_except).
 */
function protein(rec: SeqRecord, f: Feature): string | undefined {
  try {
    return translateFeature(rec, f);
  } catch {
    return undefined;
  }
}

/** A feature whose bases an operation keeps translates to the same protein afterwards. */
function expectSameProtein(before: SeqRecord, f: Feature, after: SeqRecord, g: Feature): void {
  const p = protein(before, f);
  if (p !== undefined) expect(protein(after, g), `protein of ${f.id}`).toBe(p);
}

// ---------------------------------------------------------------------------
// Edits (insert / delete / replace) against the token model
// ---------------------------------------------------------------------------

/**
 * The token layout of an edit as a per-base map for the qualifier model; `grew`: the inserted
 * bases joined the feature, so they cut a location whose adjacent bases they separate.
 */
function editModelMap(rec: SeqRecord, layout: readonly number[], grew: boolean): ModelBaseMap {
  const index = new Map(layout.map((t, i) => [t, i]));
  const circular = rec.topology === 'circular';
  return {
    base: (x) => index.get(x) ?? null,
    oldLength: rec.seq.length,
    oldCircular: circular,
    newLength: layout.length,
    newCircular: circular,
    flip: false,
    dropIfSplit: grew,
  };
}

/**
 * Check an edited record against the token model: sequence, every original feature (expected
 * segment tokens / site gaps with the contiguous-run rule, qualifiers moved / dropped, /codon_start
 * in frame, /translation dropped when the bases change, other fields unchanged), and property (a):
 * features whose bases the edit leaves alone keep their exact feature sequence.
 */
function checkEditAgainstModel(rec: SeqRecord, out: SeqRecord, edit: ModelEdit, insertedBases: string): void {
  const L = rec.seq.length;
  const layout = modelLayout(L, rec.topology, edit);
  const baseOf = (t: number) => (t >= INSERTED_TOKEN ? insertedBases[t - INSERTED_TOKEN] : rec.seq[t]);
  expect(out.seq).toBe(layout.map(baseOf).join(''));
  expect(out.topology).toBe(rec.topology);
  expect(out.id).toBe(rec.id);
  const emptyCircle = rec.topology === 'circular' && layout.length === 0;
  const remaining = new Map(out.features.map((f) => [f.id, f]));
  for (const f of rec.features) {
    const model = modelFeatureEdit(f, L, rec.topology, edit, layout);
    const g = remaining.get(f.id);
    remaining.delete(f.id);
    if (model.segments.length === 0 || emptyCircle) {
      expect(g, `feature ${f.id} should be removed`).toBeUndefined();
      continue;
    }
    expect(g, `feature ${f.id} should survive`).toBeDefined();
    const got = g as Feature;
    expect(got.segments.length, `segments of ${f.id}`).toBe(model.segments.length);
    got.segments.forEach((s, k) => {
      const e = model.segments[k];
      if ('gap' in e) expect(s, `site ${k} of ${f.id}`).toEqual({ start: e.gap, end: e.gap });
      else expect(segmentTokens(layout, s), `segment ${k} of ${f.id}`).toEqual(e.tokens);
    });
    const moved = modelQualifiers(f.qualifiers, editModelMap(rec, layout, model.grew));
    const expected = modelCodonStart(f.type, model.changed ? withoutTranslation(moved) : moved, model.lost5);
    expect(got.qualifiers, `qualifiers of ${f.id}`).toEqual(expected);
    expect(otherFields(got)).toEqual(otherFields(f));
    // (a) features whose bases are untouched keep their exact sequence (and protein)
    if (!model.changed) {
      expect(featureSequence(got, out.seq)).toBe(featureSequence(f, rec.seq));
      expectSameProtein(rec, f, out, got);
    }
  }
  expect([...remaining.keys()], 'unexpected extra features').toEqual([]);
}

/** Sticky ends after an edit: unchanged when the edit leaves an overhang alone, and in general as the per-base model says. */
function checkEnds(rec: SeqRecord, out: SeqRecord, edit: ModelEdit): void {
  if (rec.topology !== 'linear' || rec.ends === undefined) {
    expect(out.ends).toBeUndefined();
    return;
  }
  const L = rec.seq.length;
  const { start: a, deleted: d } = edit;
  const ends = out.ends as FragmentEnds;
  expect(ends).toBeDefined();
  // an edit at or after the left junction leaves the left overhang alone, and symmetrically
  if (a >= rec.ends.left.length) expect(ends.left).toEqual(rec.ends.left);
  if (a + d <= L - rec.ends.right.length) expect(ends.right).toEqual(rec.ends.right);
  // pure deletions only shorten overhangs
  if (edit.inserted === 0) {
    expect(ends.left.length).toBeLessThanOrEqual(rec.ends.left.length);
    expect(ends.right.length).toBeLessThanOrEqual(rec.ends.right.length);
  }
  // Per-base model: single-stranded bases are the original overhang bases that survive, plus the
  // inserted bases when every base they replace was single-stranded on that side (for a pure
  // insertion: when it lands strictly inside the overhang or at the molecule's outer end).
  const layout = modelLayout(L, 'linear', edit);
  const mL = rec.ends.left.length;
  const mR = rec.ends.right.length;
  const deleted = Array.from({ length: d }, (_, k) => a + k);
  const insLeft = mL > 0 && (d > 0 ? deleted.every((x) => x < mL) : a < mL);
  const insRight = mR > 0 && (d > 0 ? deleted.every((x) => x >= L - mR) : a > L - mR);
  const ssLeft = (t: number) => (t >= INSERTED_TOKEN ? insLeft : t < mL);
  const ssRight = (t: number) => (t >= INSERTED_TOKEN ? insRight : t >= L - mR);
  let prefix = 0;
  while (prefix < layout.length && ssLeft(layout[prefix])) prefix++;
  let suffix = 0;
  while (suffix < layout.length && ssRight(layout[layout.length - 1 - suffix])) suffix++;
  // the single-stranded bases of each side form a prefix / suffix of the new molecule
  expect(layout.filter(ssLeft).length).toBe(prefix);
  expect(layout.filter(ssRight).length).toBe(suffix);
  expect(ends.left).toEqual(prefix > 0 ? { kind: rec.ends.left.kind, length: prefix } : { kind: 'blunt', length: 0 });
  expect(ends.right).toEqual(suffix > 0 ? { kind: rec.ends.right.kind, length: suffix } : { kind: 'blunt', length: 0 });
}

/**
 * Features carried in from an inserted record land on the inserted tokens with unchanged sequences
 * (`insText`: the inserted bases as written into the target) and qualifiers moved with them.
 */
function checkCarried(out: SeqRecord, ins: SeqRecord, rec: SeqRecord, edit: ModelEdit, insText: string): void {
  const L = rec.seq.length;
  const layout = modelLayout(L, rec.topology, edit);
  const originalIds = new Set(rec.features.map((f) => f.id));
  const carried = out.features.slice(out.features.length - ins.features.length);
  expect(carried.length).toBe(ins.features.length);
  const insertAt = layout.indexOf(INSERTED_TOKEN);
  // a circular inserted record is opened at its origin: its bases are placed in their linear order
  const map: ModelBaseMap = {
    base: (x) => insertAt + x,
    oldLength: ins.seq.length,
    oldCircular: false,
    newLength: layout.length,
    newCircular: rec.topology === 'circular',
    flip: false,
    dropIfSplit: false,
  };
  ins.features.forEach((f, k) => {
    const g = carried[k];
    expect(labelOf(g)).toBe(labelOf(f));
    if (originalIds.has(f.id)) expect(g.id).not.toBe(f.id);
    // the carried feature covers the inserted tokens of f's bases, in order
    const insPositions = f.segments.flatMap((s) => segmentPositions(s, ins.seq.length));
    const outTokens = g.segments.flatMap((s) => segmentTokens(layout, s));
    expect(outTokens).toEqual(insPositions.map((p) => INSERTED_TOKEN + p));
    expect(featureSequence(g, out.seq)).toBe(featureSequence(f, insText));
    expect(g.qualifiers).toEqual(modelQualifiers(f.qualifiers, map));
  });
}

describe('property: insertBases', () => {
  it(`matches the token model on ${CASES} random insertions`, () => {
    forCases(1001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const snap = JSON.stringify(rec);
      const gap = edgePosition(rng, rec);
      const bases = randomBases(rng, rng.bool(0.1) ? 0 : rng.int(1, 12), rng.bool(0.3));
      // raw text may be lower case with spaces: normalizeDna cleans it
      const text = rng.bool(0.3) ? ` ${bases.toLowerCase()} ` : bases;
      const out = insertBases(rec, gap, text);
      checkPurity(rec, snap, out);
      const edit = { start: gap, deleted: 0, inserted: bases.length };
      checkEditAgainstModel(rec, out, edit, bases);
      checkEnds(rec, out, edit);
      expect(out.features.length).toBeLessThanOrEqual(rec.features.length);
    });
  });

  it(`carries the features of an inserted record (${CASES} cases)`, () => {
    forCases(1002, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      // an RNA record (written with U) is inserted as DNA (U -> T)
      const molecule = rng.bool(0.2) ? 'RNA' : 'DNA';
      const ins = deepFreeze(randomRecord(rng, { ...RICH, maxLength: 40, idPrefix: rng.bool() ? 'f' : 'g', molecule }));
      const insText = ins.seq.replace(/U/g, 'T');
      const snap = JSON.stringify([rec, ins]);
      const gap = edgePosition(rng, rec);
      const out = insertBases(rec, gap, ins);
      checkPurity([rec, ins], snap, out);
      const edit = { start: gap, deleted: 0, inserted: ins.seq.length };
      checkEditAgainstModel(rec, { ...out, features: out.features.slice(0, out.features.length - ins.features.length) }, edit, insText);
      checkCarried(out, ins, rec, edit, insText);
    });
  });
});

describe('property: edits next to sticky ends', () => {
  it(`track single-stranded bases like the per-base model (${CASES} cases)`, () => {
    forCases(1501, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, { ...RICH, topology: 'linear', minLength: 2, endsProbability: 1, maxFeatures: 2 }));
      const snap = JSON.stringify(rec);
      const range = edgeRange(rng, rec);
      const bases = randomBases(rng, rng.bool(0.3) ? 0 : rng.int(1, 5));
      const roll = rng.next();
      const out =
        roll < 0.3
          ? insertBases(rec, range.start, bases)
          : roll < 0.5
            ? deleteRange(rec, range)
            : replaceRange(rec, range, bases);
      checkPurity(rec, snap, out);
      const edit =
        roll < 0.3
          ? { start: range.start, deleted: 0, inserted: bases.length }
          : { start: range.start, deleted: range.end - range.start, inserted: roll < 0.5 ? 0 : bases.length };
      checkEditAgainstModel(rec, out, edit, roll < 0.5 && roll >= 0.3 ? '' : bases);
      checkEnds(rec, out, edit);
    });
  });
});

describe('property: deleteRange', () => {
  it(`matches the token model on ${CASES} random deletions`, () => {
    forCases(2001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const snap = JSON.stringify(rec);
      const range = edgeRange(rng, rec);
      const out = deleteRange(rec, range);
      checkPurity(rec, snap, out);
      const edit = { start: range.start, deleted: range.end - range.start, inserted: 0 };
      checkEditAgainstModel(rec, out, edit, '');
      checkEnds(rec, out, edit);
    });
  });
});

describe('property: replaceRange', () => {
  it(`matches the token model on ${CASES} random replacements`, () => {
    forCases(3001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const snap = JSON.stringify(rec);
      const range = edgeRange(rng, rec);
      const bases = randomBases(rng, rng.bool(0.15) ? 0 : rng.int(1, 12));
      const out = replaceRange(rec, range, bases);
      checkPurity(rec, snap, out);
      const edit = { start: range.start, deleted: range.end - range.start, inserted: bases.length };
      checkEditAgainstModel(rec, out, edit, bases);
      checkEnds(rec, out, edit);
    });
  });

  it(`equals insertBases for an empty range and deleteRange for an empty replacement (${CASES} cases)`, () => {
    forCases(3002, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng));
      const L = rec.seq.length;
      const bases = randomBases(rng, rng.int(0, 8));
      const gap = rec.topology === 'circular' ? rng.position(L - 1) : rng.position(L);
      expect(replaceRange(rec, { start: gap, end: gap }, bases)).toEqual(insertBases(rec, gap, bases));
      const range = randomRange(rng, L, rec.topology);
      expect(replaceRange(rec, range, '')).toEqual(deleteRange(rec, range));
    });
  });

  it(`with a record replacement carries its features (${CASES} cases)`, () => {
    forCases(3003, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const ins = deepFreeze(randomRecord(rng, { ...RICH, maxLength: 30, idPrefix: 'f' }));
      const snap = JSON.stringify([rec, ins]);
      const range = edgeRange(rng, rec);
      const out = replaceRange(rec, range, ins);
      checkPurity([rec, ins], snap, out);
      const edit = { start: range.start, deleted: range.end - range.start, inserted: ins.seq.length };
      const own = { ...out, features: out.features.slice(0, out.features.length - ins.features.length) };
      checkEditAgainstModel(rec, own, edit, ins.seq);
      checkCarried(out, ins, rec, edit, ins.seq);
    });
  });

  it(`insert then delete the inserted bases is the identity (${CASES} cases)`, () => {
    forCases(3004, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng));
      const L = rec.seq.length;
      const gap = rng.position(L);
      const bases = randomBases(rng, rng.int(1, 10));
      const mid = insertBases(rec, gap, bases);
      const at = rec.topology === 'circular' && gap === 0 ? L : gap; // circular gap 0 appends
      const back = deleteRange(mid, { start: at, end: at + bases.length });
      expect(back).toEqual(rec);
    });
  });
});

// ---------------------------------------------------------------------------
// remap API (preview) agrees with the record operations
// ---------------------------------------------------------------------------

describe('property: remapFeatures / remapRange / remapGap', () => {
  it(`agree with the record edits (${CASES} cases)`, () => {
    forCases(4001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const L = rec.seq.length;
      const roll = rng.next();
      let edit: SequenceEdit;
      let out: SeqRecord;
      if (roll < 0.33) {
        const bases = randomBases(rng, rng.int(0, 9));
        edit = { kind: 'insert', gap: rng.position(L), length: bases.length };
        out = insertBases(rec, edit.gap, bases);
      } else if (roll < 0.66) {
        edit = { kind: 'delete', range: randomRange(rng, L, rec.topology) };
        out = deleteRange(rec, edit.range);
      } else {
        const bases = randomBases(rng, rng.int(0, 9));
        edit = { kind: 'replace', range: randomRange(rng, L, rec.topology), length: bases.length };
        out = replaceRange(rec, edit.range, bases);
      }
      const plan = planEdit(edit, L, rec.topology);
      expect(plan.newLength).toBe(out.seq.length);
      // remapFeatures is the preview of the edit: exactly the edited record's features
      expect(remapFeatures(rec.features, edit, L, rec.topology)).toEqual(out.features);
      for (const f of rec.features) {
        // remapRange gives the image of a feature made of that one segment (null when removed)
        for (const seg of f.segments) {
          const alone = remapFeatures([{ ...f, segments: [seg] }], edit, L, rec.topology);
          expect(remapRange(seg, edit, L, rec.topology)).toEqual(alone.length > 0 ? alone[0].segments[0] : null);
        }
        // without adjacent segments (no contiguous run), the images are the edited segments, in order
        if (contiguousRuns(f.segments, L, rec.topology).every((group) => group.length === 1)) {
          const images = f.segments.map((seg) => remapRange(seg, edit, L, rec.topology)).filter((x) => x !== null);
          expect(images).toEqual(out.features.find((g) => g.id === f.id)?.segments ?? []);
        }
      }
      // carets: every gap maps into the new molecule; gaps outside the edit keep their neighbours
      const N = out.seq.length;
      const norm = (x: number) => (rec.topology === 'circular' ? (N > 0 ? mod(x, N) : 0) : x);
      const g = rng.position(L);
      for (const bias of ['left', 'right'] as const) {
        const ng = remapGap(g, edit, L, rec.topology, bias);
        expect(Number.isInteger(ng)).toBe(true);
        expect(Object.is(ng, -0)).toBe(false);
        expect(ng).toBeGreaterThanOrEqual(0);
        if (rec.topology === 'circular') expect(ng).toBeLessThan(Math.max(1, N));
        else expect(ng).toBeLessThanOrEqual(N);
        // gaps from the left to the right boundary of the edited region collapse onto the insertion
        // point: 'right' puts all of them after the inserted bases; 'left' puts them before, except
        // the right boundary of a deleted region (it keeps its right neighbour)
        const off = rec.topology === 'circular' ? mod(g - plan.start, L) : g - plan.start;
        if (off >= 0 && off <= plan.deleted) {
          const after = norm(plan.insertAt + plan.inserted);
          const before = norm(plan.insertAt);
          if (bias === 'right') expect(ng).toBe(after);
          else expect(ng).toBe(off === plan.deleted && plan.deleted > 0 ? after : before);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// rotateOrigin
// ---------------------------------------------------------------------------

describe('property: rotateOrigin', () => {
  it(`preserves every base and feature (${CASES} cases), and k then L-k is the identity`, () => {
    forCases(5001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, { ...RICH, topology: 'circular' }));
      const snap = JSON.stringify(rec);
      const L = rec.seq.length;
      const k = rng.position(L);
      const out = rotateOrigin(rec, k);
      checkPurity(rec, snap, out);
      expect(out.seq).toBe(rec.seq.slice(k % L) + rec.seq.slice(0, k % L));
      // token model: new position y holds old base (y + k) mod L
      const layout = Array.from({ length: L }, (_, y) => (y + k) % L);
      const map: ModelBaseMap = { base: (x) => mod(x - k, L), oldLength: L, oldCircular: true, newLength: L, newCircular: true, flip: false, dropIfSplit: false };
      rec.features.forEach((f, i) => {
        const g = out.features[i];
        expect(g.id).toBe(f.id);
        expect(otherFields(g)).toEqual(otherFields(f));
        // position-bearing qualifiers move with their bases; /translation and /codon_start stay
        expect(g.qualifiers).toEqual(modelQualifiers(f.qualifiers, map));
        expect(g.segments.length).toBe(f.segments.length);
        g.segments.forEach((s, j) => {
          expect(s.end - s.start).toBe(f.segments[j].end - f.segments[j].start);
          expect(segmentTokens(layout, s)).toEqual(segmentPositions(f.segments[j], L));
          if (s.end === s.start) expect(mod(s.start + k, L)).toBe(mod(f.segments[j].start, L));
        });
        // (b) exact feature sequence, and the same protein
        expect(featureSequence(g, out.seq)).toBe(featureSequence(f, rec.seq));
        expectSameProtein(rec, f, out, g);
      });
      // (f) rotating by k then by L - k is the identity, position-bearing qualifiers included,
      // except for the documented case of qualifiers.ts: the origin put between two consecutive
      // bases that a value writes as separate parts (they come back written as one run)
      const back = rotateOrigin(out, L - k);
      if (!originBetweenWrittenParts(rec, k)) expect(back).toEqual(rec);
      else {
        const mapBack: ModelBaseMap = { ...map, base: (x) => mod(x + k, L) };
        back.features.forEach((g, i) => expect(g.qualifiers).toEqual(modelQualifiers(modelQualifiers(rec.features[i].qualifiers, map), mapBack)));
        const withoutQualifiers = (r: SeqRecord) => ({ ...r, features: r.features.map((f) => ({ ...f, qualifiers: [] })) });
        expect(withoutQualifiers(back)).toEqual(withoutQualifiers(rec));
      }
    });
  });
});

/**
 * True when rotating `rec` by `k` puts the new origin between two consecutive bases that a
 * position-bearing qualifier writes as separate parts (e.g. join(1,2,3) rotated by 1).
 */
function originBetweenWrittenParts(rec: SeqRecord, k: number): boolean {
  const L = rec.seq.length;
  return rec.features.some((f) =>
    f.qualifiers.some((q) => {
      const parts = q.value === null ? null : writtenParts(q.key, q.value, L);
      return parts !== null && parts.some((p, i) => i > 0 && mod(parts[i - 1].last + 1, L) === p.first && p.first === mod(k, L));
    }),
  );
}

// ---------------------------------------------------------------------------
// reverseComplementRecord
// ---------------------------------------------------------------------------

describe('property: reverseComplementRecord', () => {
  it(`preserves every stranded feature sequence and is an involution (${CASES} cases)`, () => {
    forCases(6001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, { ...RICH, iupac: true }));
      const snap = JSON.stringify(rec);
      const L = rec.seq.length;
      const out = reverseComplementRecord(rec);
      checkPurity(rec, snap, out);
      expect(out.seq).toBe(reverseComplement(rec.seq));
      const circular = rec.topology === 'circular';
      const map: ModelBaseMap = { base: (x) => L - 1 - x, oldLength: L, oldCircular: circular, newLength: L, newCircular: circular, flip: true, dropIfSplit: false };
      rec.features.forEach((f, i) => {
        const g = out.features[i];
        expect(g.id).toBe(f.id);
        expect(g.qualifiers).toEqual(modelQualifiers(f.qualifiers, map));
        expect(g.strand).toBe(f.strand === 0 ? 0 : -f.strand);
        expect(g.partialStart).toBe(f.partialEnd);
        expect(g.partialEnd).toBe(f.partialStart);
        // token model: new base y is the complement of old base L-1-y; the path is reversed
        const oldPath = f.segments.flatMap((s) => segmentPositions(s, L));
        const newPath = g.segments.flatMap((s) => segmentPositions(s, L)).map((y) => L - 1 - y);
        expect(newPath).toEqual([...oldPath].reverse());
        // (b) stranded features keep their exact 5'->3' sequence; strand 0 reads reverse-complemented
        const before = featureSequence(f, rec.seq);
        expect(featureSequence(g, out.seq)).toBe(f.strand === 0 ? reverseComplement(before) : before);
        if (f.strand !== 0) expectSameProtein(rec, f, out, g);
      });
      if (rec.ends !== undefined) expect(out.ends).toEqual({ left: rec.ends.right, right: rec.ends.left });
      expect(reverseComplementRecord(out)).toEqual(rec);
    });
  });

  it(`keeps RNA records written with U and is an involution on them (${CASES} cases)`, () => {
    forCases(6002, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, { ...RICH, molecule: 'RNA', iupac: true }));
      const snap = JSON.stringify(rec);
      const out = reverseComplementRecord(rec);
      checkPurity(rec, snap, out);
      expect(out.molecule).toBe('RNA');
      // A pairs with U (Biopython reverse_complement_rna): the DNA reverse complement written with U
      expect(out.seq).toBe(reverseComplement(rec.seq.replace(/U/g, 'T')).replace(/T/g, 'U'));
      expect(reverseComplementRecord(out)).toEqual(rec);
    });
  });
});

// ---------------------------------------------------------------------------
// setTopology
// ---------------------------------------------------------------------------

describe('property: setTopology', () => {
  it(`keeps every base of every feature in place (${CASES} cases)`, () => {
    forCases(7001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const snap = JSON.stringify(rec);
      const L = rec.seq.length;
      const target: Topology = rec.topology === 'linear' ? 'circular' : 'linear';
      const out = setTopology(rec, target);
      checkPurity(rec, snap, out);
      expect(out.seq).toBe(rec.seq);
      expect(out.topology).toBe(target);
      expect(out.ends).toBeUndefined();
      rec.features.forEach((f, i) => {
        const g = out.features[i];
        expect(nonPositional(g)).toEqual(nonPositional(f));
        expect(g.segments.flatMap((s) => segmentPositions(s, L))).toEqual(f.segments.flatMap((s) => segmentPositions(s, L)));
        expect(featureSequence(g, out.seq)).toBe(featureSequence(f, rec.seq));
        if (target === 'circular') expect(g.segments.length).toBe(f.segments.length);
        else expect(g.segments.length).toBe(f.segments.length + f.segments.filter((s) => s.end > L).length);
      });
      // circular -> linear -> circular keeps every feature sequence
      const back = setTopology(out, rec.topology);
      back.features.forEach((g, i) => expect(featureSequence(g, back.seq)).toBe(featureSequence(rec.features[i], rec.seq)));
      // same topology: an equal copy (minus ends on circular records)
      expect(setTopology(rec, rec.topology)).toEqual(rec);
    });
  });
});

// ---------------------------------------------------------------------------
// extractRange
// ---------------------------------------------------------------------------

type Entry = { base: number } | { site: number };

/** One piece of a clipped feature in the model: its entries and the feature bases walked before / through it. */
interface ModelPiece {
  entries: Entry[];
  /** Feature bases (traversal order) before the piece's first entry. */
  from: number;
  /** Feature bases (traversal order) up to and including the piece's last base. */
  to: number;
}

/**
 * Model of the clipped feature: walking the feature in traversal order, bases inside the region
 * (as fragment offsets) and sites in the region are kept; a lost base between two kept entries
 * starts a new piece. Returns the pieces, whether bases were lost before / after them, and the
 * number of bases of the feature.
 */
function modelClip(f: Feature, region: Range, L: number, topology: Topology): { groups: Entry[][]; pieces: ModelPiece[]; lead: boolean; trail: boolean; total: number } {
  const ring = topology === 'circular' && L > 0;
  const len = region.end - region.start;
  const pieces: ModelPiece[] = [];
  let walked = 0;
  let lost = false;
  let lead = false;
  const push = (e: Entry) => {
    if (pieces.length === 0) lead = lost;
    if (pieces.length === 0 || lost) pieces.push({ entries: [], from: walked, to: walked });
    const piece = pieces[pieces.length - 1];
    piece.entries.push(e);
    if ('base' in e) walked++;
    piece.to = walked;
    lost = false;
  };
  for (const seg of f.segments) {
    if (seg.end === seg.start) {
      const o = ring ? mod(seg.start - region.start, L) : seg.start - region.start;
      if (o >= 0 && o <= len) push({ site: o });
      continue;
    }
    for (const x of segmentPositions(seg, L)) {
      const o = ring ? mod(x - region.start, L) : x - region.start;
      if (o >= 0 && o < len) push({ base: o });
      else {
        lost = true;
        walked++;
      }
    }
  }
  return { groups: pieces.map((p) => p.entries), pieces, lead, trail: lost, total: walked };
}

function entriesOf(f: Feature): Entry[] {
  return f.segments.flatMap((s): Entry[] =>
    s.end === s.start ? [{ site: s.start }] : segmentPositions(s, Number.MAX_SAFE_INTEGER).map((b) => ({ base: b })),
  );
}

describe('property: extractRange', () => {
  it(`clips features exactly like the per-base model (${CASES} cases)`, () => {
    forCases(8001, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const snap = JSON.stringify(rec);
      const L = rec.seq.length;
      const region = edgeRange(rng, rec);
      const out = extractRange(rec, region);
      checkPurity(rec, snap, out);
      expect(out.topology).toBe('linear');
      expect(out.ends).toBeUndefined();
      expect(out.id).not.toBe(rec.id);
      const len = region.end - region.start;
      expect(out.seq.length).toBe(len);
      for (let o = 0; o < len; o++) expect(out.seq[o]).toBe(rec.seq[(region.start + o) % L]);
      expect(out.meta.accession).toBeUndefined();
      expect(out.meta.version).toBeUndefined();
      expect(out.meta.organism).toBe(rec.meta.organism);
      expect(out.primers).toEqual(rec.primers);
      const ring = rec.topology === 'circular';
      const map: ModelBaseMap = {
        base: (x) => {
          const o = ring ? mod(x - region.start, L) : x - region.start;
          return o >= 0 && o < len ? o : null;
        },
        oldLength: L,
        oldCircular: ring,
        newLength: len,
        newCircular: false,
        flip: false,
        dropIfSplit: false,
      };
      let next = 0;
      for (const f of rec.features) {
        const model = modelClip(f, region, L, rec.topology);
        const pieces = out.features.slice(next, next + model.groups.length);
        next += model.groups.length;
        expect(pieces.length).toBe(model.groups.length);
        const clipped = model.groups.length > 1 || model.lead || model.trail;
        pieces.forEach((g, k) => {
          expect(labelOf(g)).toBe(labelOf(f));
          expect(g.strand).toBe(f.strand);
          if (k === 0) expect(g.id).toBe(f.id);
          else expect(g.id).not.toBe(f.id);
          expect(entriesOf(g)).toEqual(model.groups[k]);
          const last = model.groups.length - 1;
          expect(g.partialStart ?? false).toBe(k > 0 || model.lead || (f.partialStart ?? false));
          expect(g.partialEnd ?? false).toBe(k < last || model.trail || (f.partialEnd ?? false));
          // qualifiers: positions in fragment coordinates (kept only on the piece holding all of
          // their bases), /translation dropped from clipped pieces, /codon_start in frame
          const own = new Set(model.pieces[k].entries.flatMap((e) => ('base' in e ? [e.base] : [])));
          const keep = model.groups.length > 1 ? (positions: number[]) => positions.every((y) => own.has(y)) : undefined;
          const moved = modelQualifiers(f.qualifiers, map, keep);
          const lost5 = f.strand === -1 ? model.total - model.pieces[k].to : model.pieces[k].from;
          expect(g.qualifiers, `qualifiers of piece ${k} of ${f.id}`).toEqual(
            modelCodonStart(f.type, clipped ? withoutTranslation(moved) : moved, lost5),
          );
        });
        // (c) fully contained features keep their exact sequence
        const contained = model.groups.length === 1 && !model.lead && !model.trail && f.segments.every((s) => s.end > s.start);
        const allBasesInside = f.segments.every((s) => {
          if (s.end === s.start) return true;
          return segmentPositions(s, L).every((x) => {
            const o = rec.topology === 'circular' ? mod(x - region.start, L) : x - region.start;
            return o >= 0 && o < len;
          });
        });
        if (allBasesInside && f.segments.every((s) => s.end > s.start)) {
          expect(contained).toBe(true);
          expect(featureSequence(pieces[0], out.seq)).toBe(featureSequence(f, rec.seq));
          expectSameProtein(rec, f, out, pieces[0]);
        }
      }
      expect(next).toBe(out.features.length);
    });
  });

  it(`of the whole molecule keeps every feature sequence (${CASES} cases)`, () => {
    forCases(8002, CASES, (rng) => {
      const rec = deepFreeze(randomRecord(rng, RICH));
      const L = rec.seq.length;
      const start = rec.topology === 'circular' ? rng.position(L - 1) : 0;
      const out = extractRange(rec, { start, end: start + L });
      expect(out.features.length).toBe(rec.features.length);
      out.features.forEach((g, i) => {
        expect(featureSequence(g, out.seq)).toBe(featureSequence(rec.features[i], rec.seq));
        expect(g.partialStart).toBe(rec.features[i].partialStart);
        expect(g.partialEnd).toBe(rec.features[i].partialEnd);
      });
      if (start === 0) {
        const opened = setTopology(rec, 'linear');
        expect(out.features).toEqual(opened.features);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// concatRecords
// ---------------------------------------------------------------------------

describe('property: concatRecords', () => {
  it(`joins compatible fragments and preserves every feature sequence (${CASES} cases)`, () => {
    forCases(9001, CASES, (rng) => {
      const closable = rng.bool(0.4);
      const { parts, product, offsets } = ligatableParts(rng, closable, RICH);
      deepFreeze(parts);
      const snap = JSON.stringify(parts);
      const out = concatRecords(parts);
      checkPurity(parts, snap, out);
      expect(out.seq).toBe(product);
      // features shifted by the part offsets, sequences preserved exactly (b), qualifiers moved
      let k = 0;
      parts.forEach((p, i) => {
        const map: ModelBaseMap = {
          base: (x) => x + offsets[i],
          oldLength: p.seq.length,
          oldCircular: false,
          newLength: product.length,
          newCircular: false,
          flip: false,
          dropIfSplit: false,
        };
        for (const f of p.features) {
          const g = out.features[k++];
          expect(labelOf(g)).toBe(labelOf(f));
          expect(g.segments).toEqual(f.segments.map((s) => ({ start: s.start + offsets[i], end: s.end + offsets[i] })));
          expect(featureSequence(g, out.seq)).toBe(featureSequence(f, p.seq));
          expect(g.qualifiers).toEqual(modelQualifiers(f.qualifiers, map));
        }
      });
      const left = parts[0].ends?.left;
      const right = parts[parts.length - 1].ends?.right;
      if ((left?.length ?? 0) > 0 || (right?.length ?? 0) > 0) expect(out.ends).toEqual({ left, right });
      else expect(out.ends).toBeUndefined();
      if (closable) {
        const n = parts[0].ends?.left.length ?? 0;
        if (product.length - n > 0) {
          const circ = concatRecords(parts, { topology: 'circular' });
          expect(recordProblems(circ)).toEqual([]);
          expect(circ.seq).toBe(product.slice(0, product.length - n));
          expect(circ.ends).toBeUndefined();
          const T = circ.seq.length;
          // the linear product's bases put onto the circle (the shared closing overhang once)
          const map: ModelBaseMap = {
            base: (y) => mod(y, T),
            oldLength: product.length,
            oldCircular: false,
            newLength: T,
            newCircular: true,
            flip: false,
            dropIfSplit: false,
          };
          out.features.forEach((g, j) => {
            const c = circ.features[j];
            const total = g.segments.reduce((acc, s) => acc + s.end - s.start, 0);
            const clamped = g.segments.some((s) => s.end - s.start > T);
            if (!clamped) expect(featureSequence(c, circ.seq)).toBe(featureSequence(g, out.seq));
            else expect(total).toBeGreaterThan(T);
            // a clamped feature loses bases: /translation dropped, /codon_start kept in frame when
            // the lost bases are at its 5' end (strand -1: the right end of its last segment)
            const lastSegment = [...g.segments].reverse().find((s) => s.end > s.start);
            const lost5 = g.strand === -1 && lastSegment !== undefined ? Math.max(0, lastSegment.end - lastSegment.start - T) : 0;
            const moved = modelQualifiers(g.qualifiers, map);
            expect(c.qualifiers).toEqual(modelCodonStart(g.type, clamped ? withoutTranslation(moved) : moved, lost5));
          });
        }
      }
    });
  });

  it(`rejects incompatible junctions (${CASES} cases)`, () => {
    forCases(9002, CASES, (rng) => {
      const { parts } = ligatableParts(rng, false);
      if (parts.length < 2) return;
      const i = rng.int(0, parts.length - 2);
      const a = parts[i];
      const b = parts[i + 1];
      const right = a.ends?.right ?? { kind: 'blunt', length: 0 };
      // break the junction: change the kind, the length, or the overhang text
      const roll = rng.next();
      let broken: SeqRecord[];
      if (right.length === 0) {
        broken = parts.map((p, j) => (j === i + 1 ? { ...b, ends: { left: { kind: '5prime', length: 1 }, right: b.ends?.right ?? { kind: 'blunt', length: 0 } } } : p));
      } else if (roll < 0.33) {
        const other = right.kind === '5prime' ? '3prime' : '5prime';
        broken = parts.map((p, j) => (j === i ? { ...a, ends: { left: a.ends?.left ?? { kind: 'blunt', length: 0 }, right: { kind: other, length: right.length } } } : p));
      } else if (roll < 0.66) {
        broken = parts.map((p, j) => (j === i ? { ...a, ends: { left: a.ends?.left ?? { kind: 'blunt', length: 0 }, right: { kind: 'blunt', length: 0 } } } : p));
      } else {
        // change the first base of b's left overhang so that the overhang texts differ
        const flipped = b.seq[0] === 'A' ? 'C' : 'A';
        broken = parts.map((p, j) => (j === i + 1 ? { ...b, seq: flipped + b.seq.slice(1) } : p));
      }
      expect(() => concatRecords(broken)).toThrow(/incompatible ends/);
    });
  });

  it(`opens circular parts at their origin (${CASES} cases)`, () => {
    forCases(9003, CASES, (rng) => {
      const parts = Array.from({ length: rng.int(1, 3) }, (_, i) =>
        deepFreeze(randomRecord(rng, { ...RICH, endsProbability: 0, idPrefix: `p${i}_` })),
      );
      const out = concatRecords(parts);
      expect(out.seq).toBe(parts.map((p) => p.seq).join(''));
      let k = 0;
      let offset = 0;
      for (const p of parts) {
        const at = offset;
        const map: ModelBaseMap = {
          base: (x) => x + at,
          oldLength: p.seq.length,
          oldCircular: false, // a circular part is opened at its origin
          newLength: out.seq.length,
          newCircular: false,
          flip: false,
          dropIfSplit: false,
        };
        for (const f of p.features) {
          const g = out.features[k++];
          expect(featureSequence(g, out.seq)).toBe(featureSequence(f, p.seq));
          expect(g.qualifiers).toEqual(modelQualifiers(f.qualifiers, map));
        }
        offset += p.seq.length;
      }
      expect(recordProblems(out)).toEqual([]);
      const circ = concatRecords(parts, { topology: 'circular' });
      expect(recordProblems(circ)).toEqual([]);
      circ.features.forEach((c, j) => expect(featureSequence(c, circ.seq)).toBe(featureSequence(out.features[j], out.seq)));
    });
  });
});

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

describe('property: feature / primer CRUD', () => {
  it(`matches a plain-array model over random operation sequences (${CASES} cases)`, () => {
    forCases(10001, CASES, (rng) => {
      let rec = deepFreeze(randomRecord(rng));
      let model = { features: rec.features.map((f) => structuredClone(f)), primers: rec.primers.map((p) => ({ ...p })) };
      for (let step = 0; step < 5; step++) {
        const snap = JSON.stringify(rec);
        const L = rec.seq.length;
        const roll = rng.next();
        let out: SeqRecord;
        if (roll < 0.25) {
          const f = randomFeature(rng, L, rec.topology, `new${step}`);
          out = addFeature(rec, f);
          model.features.push(structuredClone(f));
        } else if (roll < 0.45 && rec.features.length > 0) {
          const target = rng.pick(rec.features);
          const segments = [randomRange(rng, L, rec.topology, 1)];
          const patch = { name: `renamed${step}`, segments, strand: rng.pick([1, -1, 0] as const), color: undefined };
          out = updateFeature(rec, target.id, patch);
          model.features = model.features.map((f) => {
            if (f.id !== target.id) return f;
            const { color: _dropped, ...rest } = f;
            return { ...rest, name: patch.name, segments: structuredClone(segments), strand: patch.strand };
          });
        } else if (roll < 0.6 && rec.features.length > 0) {
          const target = rng.pick(rec.features);
          out = removeFeature(rec, target.id);
          model.features = model.features.filter((f) => f.id !== target.id);
        } else if (roll < 0.8) {
          const seq = randomBases(rng, rng.int(5, 30));
          out = addPrimer(rec, { id: `np${step}`, name: `p${step}`, sequence: ` ${seq.toLowerCase()} ` });
          model.primers.push({ id: `np${step}`, name: `p${step}`, sequence: seq });
        } else if (rec.primers.length > 0) {
          const target = rng.pick(rec.primers);
          if (rng.bool()) {
            out = removePrimer(rec, target.id);
            model.primers = model.primers.filter((p) => p.id !== target.id);
          } else {
            out = updatePrimer(rec, target.id, { name: 'changed', description: undefined });
            model.primers = model.primers.map((p) => {
              if (p.id !== target.id) return p;
              const { description: _gone, ...rest } = p;
              return { ...rest, name: 'changed' };
            });
          }
        } else {
          continue;
        }
        checkPurity(rec, snap, out);
        expect(out.features).toEqual(model.features);
        expect(out.primers).toEqual(model.primers);
        expect({ ...out, features: [], primers: [] }).toEqual({ ...rec, features: [], primers: [] });
        rec = deepFreeze(out);
        model = { features: model.features.map((f) => structuredClone(f)), primers: model.primers.map((p) => ({ ...p })) };
      }
    });
  });
});
