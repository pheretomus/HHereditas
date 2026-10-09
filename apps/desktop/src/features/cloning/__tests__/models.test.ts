import { describe, expect, it } from 'vitest';
import { getLadder, reverseComplement } from '@hhereditas/core';
import { productGelLanes, resolveSource, withProvenance } from '../model/common';
import { defaultPrimers, pcrProductRecord, primersForRange, resolvePrimer, runPcr } from '../model/pcr';
import { cloningEnzymes, fragmentChoices, junctionSummary, restrictionProductRecord, runRestriction, suggestEnzymes } from '../model/restriction';
import { amountsFor, assemblyProductRecord, designProductRecord, likelyVector, newEntry, primerOrderList, primersForTemplates, resolveEntries, runAssembly, runDesign } from '../model/gibson';
import { GOLDEN_GATE_ENZYMES, goldenGateProductRecord, orderRows, runGoldenGate } from '../model/goldenGate';
import { bsaPart, doc, sample } from './fixtures';

describe('common', () => {
  it('resolves a selection of a circular document across the origin', () => {
    const d = doc(sample('pUC19'));
    const rec = resolveSource([d], { docId: d.id, range: { start: 2680, end: 2696 } })!;
    expect(rec.topology).toBe('linear');
    expect(rec.seq).toBe(d.record.seq.slice(2680) + d.record.seq.slice(0, 10));
    expect(rec.name).toBe('pUC19 2,681..10');
    expect(resolveSource([d], { docId: 'gone', range: null })).toBeNull();
  });

  it('stamps provenance as a comment', () => {
    const rec = withProvenance(sample('pUC19'), 'Made somehow');
    expect(rec.meta.comments?.[0]).toMatch(/^Made somehow \(Made with HHereditas, \d{4}-\d\d-\d\d\)\.$/);
  });

  it('builds a ladder and a product lane', () => {
    const lanes = productGelLanes([{ seq: 'A'.repeat(1500), topology: 'linear' }], getLadder('neb-1kb-plus')!);
    expect(lanes.map((l) => l.kind)).toEqual(['ladder', 'sample']);
    expect(lanes[1].bands.length).toBe(1);
  });
});

describe('PCR', () => {
  const puc = sample('pUC19');

  it('makes primers from a selected range', () => {
    const seq = puc.seq.slice(100, 400);
    const p = primersForRange(seq);
    expect(p.forward).toBe(seq.slice(0, 20));
    expect(p.reverse).toBe(reverseComplement(seq.slice(280)));
    const d = defaultPrimers(puc, seq);
    expect(d.forward).toEqual({ kind: 'custom', sequence: p.forward });
  });

  it('defaults to saved primers binding each strand', () => {
    const rec = {
      ...puc,
      primers: [
        { id: 'r', name: 'R', sequence: reverseComplement(puc.seq.slice(480, 500)) },
        { id: 'f', name: 'F', sequence: puc.seq.slice(100, 120) },
      ],
    };
    expect(defaultPrimers(rec, null)).toEqual({ forward: { kind: 'saved', primerId: 'f' }, reverse: { kind: 'saved', primerId: 'r' } });
  });

  it('validates typed primers', () => {
    expect(resolvePrimer(puc, { kind: 'custom', sequence: '' }, 'F').problem).toMatch(/Enter/);
    expect(resolvePrimer(puc, { kind: 'custom', sequence: 'ACGTXZ' }, 'F').problem).toMatch(/IUPAC/);
    expect(resolvePrimer(puc, { kind: 'custom', sequence: 'acg tac gta cgt' }, 'F').primer?.sequence).toBe('ACGTACGTACGT');
  });

  it('runs the reaction and builds the product document with a tail', () => {
    const fwd = 'GAATTC' + puc.seq.slice(100, 120);
    const rev = reverseComplement(puc.seq.slice(480, 500));
    const preview = runPcr(puc, { kind: 'custom', sequence: fwd }, { kind: 'custom', sequence: rev });
    expect(preview.result?.error).toBeUndefined();
    expect(preview.result?.products[0].seq.length).toBe(406);
    const product = pcrProductRecord(puc, preview, 0)!;
    expect(product.topology).toBe('linear');
    expect(product.primers.length).toBe(2);
    expect(product.meta.comments?.[0]).toContain('PCR product (406 bp) of pUC19');
  });

  it('reports input and engine errors', () => {
    expect(runPcr(puc, { kind: 'custom', sequence: '' }, { kind: 'custom', sequence: 'ACGTACGTACGT' }).inputError).toMatch(/^Forward primer/);
    const none = runPcr(puc, { kind: 'custom', sequence: 'ACGTACGTACGTACGTACGT' }, { kind: 'custom', sequence: reverseComplement(puc.seq.slice(480, 500)) });
    expect(none.result?.error).toMatch(/bind/);
    expect(pcrProductRecord(puc, none, 0)).toBeNull();
  });
});

describe('restriction cloning', () => {
  const puc = sample('pUC19');
  const pbr = sample('pBR322');

  it('lists enzymes with cut counts, unique vector cutters that cut the insert first', () => {
    const list = cloningEnzymes(puc, pbr);
    const ecori = list.find((e) => e.name === 'EcoRI')!;
    expect(ecori).toEqual({ name: 'EcoRI', vectorCuts: 1, insertCuts: 1 });
    expect(list.every((e) => e.vectorCuts > 0)).toBe(true);
    const firstLate = list.findIndex((e) => e.vectorCuts !== 1 || e.insertCuts === 0);
    expect(list.slice(firstLate).every((e) => e.vectorCuts !== 1 || e.insertCuts === 0)).toBe(true);
  });

  it('suggests a working directional pair', () => {
    const names = suggestEnzymes(puc, pbr);
    expect(names.length).toBe(2);
    const res = runRestriction({ vector: puc, insert: pbr, enzymes: names, vectorFragment: 'largest', insertFragment: 'auto', orientation: 'both' })!;
    expect(res.product).toBeDefined();
  });

  it('clones BamHI/HindIII tet fragment of pBR322 into pUC19', () => {
    const inputs = { vector: puc, insert: pbr, enzymes: ['BamHI', 'HindIII'], vectorFragment: 'largest' as const, insertFragment: 'auto' as const, orientation: 'both' as const };
    const res = runRestriction(inputs)!;
    expect(res.error).toBeUndefined();
    expect(res.products.length).toBe(1);
    expect(junctionSummary(res, 0)).toBe('HindIII (AGCT) · BamHI (GATC)');
    const rec = restrictionProductRecord(inputs, res, 0)!;
    expect(rec.topology).toBe('circular');
    expect(rec.meta.comments?.[0]).toContain('ligated (reverse orientation) into');
    expect(fragmentChoices(pbr, ['BamHI', 'HindIII']).map((f) => f.size).sort((a, b) => a - b)).toEqual([346, 4015]);
  });

  it('returns an error for an enzyme that does not cut the vector', () => {
    const res = runRestriction({ vector: puc, insert: pbr, enzymes: ['NotI'], vectorFragment: 'largest', insertFragment: 'auto', orientation: 'both' })!;
    expect(res.error).toBeTruthy();
    expect(runRestriction({ vector: puc, insert: pbr, enzymes: [], vectorFragment: 'largest', insertFragment: 'auto', orientation: 'both' })).toBeNull();
  });
});

describe('Gibson', () => {
  const puc = sample('pUC19');
  const pbr = sample('pBR322');

  it('designs primers, assembles the designed fragments back, and plans template primers', () => {
    const v = doc(puc);
    const i = doc(pbr);
    const entries = [newEntry({ docId: i.id, range: { start: 85, end: 1276 } })];
    const inserts = resolveEntries([v, i], entries) as NonNullable<ReturnType<typeof resolveEntries>[number]>[];
    const design = runDesign({ vector: puc, insertion: { start: 400, end: 450 }, inserts, overlapLength: 20 })!;
    expect(design.error).toBeUndefined();
    expect(design.primers.length).toBe(4);
    expect(primerOrderList(design.primers).split('\n')[0]).toMatch(/^pUC19-F\t[ACGT]+\t\d+$/);
    const asm = runAssembly({ fragments: design.fragments, minOverlap: 15, circular: true })!;
    expect(asm.product?.seq.length).toBe(design.product!.seq.length);
    const rec = designProductRecord(design, puc, inserts)!;
    expect(rec.primers.length).toBe(4);
    const plan = primersForTemplates(design, v.id, [i.id], [v, i]);
    expect(plan.map((p) => [p.docId, p.primers.length])).toEqual([
      [v.id, 2],
      [i.id, 2],
    ]);
    expect(assemblyProductRecord(asm, design.fragments)?.meta.comments?.[0]).toContain('Gibson assembly');
  });

  it('explains a circular fragment and a missing overlap', () => {
    expect(runAssembly({ fragments: [puc], minOverlap: 15, circular: true })?.error).toMatch(/circular/);
    const a = { ...pbr, topology: 'linear' as const, seq: pbr.seq.slice(0, 500), features: [] };
    const b = { ...pbr, topology: 'linear' as const, seq: pbr.seq.slice(1000, 1500), features: [] };
    expect(runAssembly({ fragments: [a, b], minOverlap: 15, circular: true })?.error).toBeTruthy();
  });

  it('reverse-complements an entry', () => {
    const i = doc(pbr);
    const [rec] = resolveEntries([i], [newEntry({ docId: i.id, range: { start: 0, end: 30 } }, true)]);
    expect(rec?.seq).toBe(reverseComplement(pbr.seq.slice(0, 30)));
  });

  it('computes NEBuilder amounts with the longest fragment as vector', () => {
    const frags = [
      { name: 'ins', lengthBp: 500 },
      { name: 'vec', lengthBp: 5000 },
    ];
    const v = likelyVector(frags);
    expect(v).toBe(1);
    const t = amountsFor({ fragments: frags, vectorIndex: v, vectorNg: null, ratio: null });
    expect(t.amounts?.rows[0].role).toBe('vector');
    expect(t.amounts?.rows[0].ng).toBeCloseTo(50, 6);
    expect(t.amounts?.rows[0].pmol).toBeCloseTo(0.0154, 3);
    expect(t.amounts?.rows[1].ratio).toBe(2);
    expect(t.fragmentOfRow).toEqual([1, 0]);
    const custom = amountsFor({ fragments: frags, vectorIndex: v, vectorNg: 100, ratio: 3 });
    expect(custom.amounts?.rows[1].ng).toBeCloseTo(30, 6);
  });
});

describe('Golden Gate', () => {
  const parts = [bsaPart('promoter', 'AATG', 'AGGT', 1), bsaPart('cds', 'AGGT', 'GCTT', 2), bsaPart('terminator', 'GCTT', 'AATG', 3)];

  it('offers BsaI first', () => {
    expect(GOLDEN_GATE_ENZYMES[0].name).toBe('BsaI');
  });

  it('assembles three parts in shuffled order and lists the overhangs', () => {
    const shuffled = [parts[0], parts[2], parts[1]];
    const res = runGoldenGate({ parts: shuffled, enzyme: 'BsaI', circular: true })!;
    expect(res.error).toBeUndefined();
    const rows = orderRows(res, shuffled);
    expect(rows.map((r) => r.name)).toEqual(['promoter', 'cds', 'terminator']);
    expect(rows.map((r) => `${r.left}>${r.right}`)).toEqual(['AATG>AGGT', 'AGGT>GCTT', 'GCTT>AATG']);
    const rec = goldenGateProductRecord(res, shuffled, 'BsaI')!;
    expect(rec.topology).toBe('circular');
    expect(rec.meta.comments?.[0]).toContain('promoter → cds → terminator');
    // Bare parts are annotated; the pieces tile the circle, sharing their 4-nt overhangs.
    const pieces = rec.features.filter((f) => f.type === 'misc_feature');
    expect(pieces.map((f) => f.name)).toEqual(['promoter', 'cds', 'terminator']);
    const covered = pieces.reduce((n, f) => n + f.segments[0].end - f.segments[0].start, 0);
    expect(covered).toBe(rec.seq.length + 3 * 4);
  });

  it('reports parts without sites', () => {
    const res = runGoldenGate({ parts: [sample('pUC19')], enzyme: 'BsaI', circular: true })!;
    expect(res.error).toMatch(/BsaI/);
  });
});
