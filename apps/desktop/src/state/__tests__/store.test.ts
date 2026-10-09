import { makeFeature, makeRecord, parseAny } from '@hhereditas/core';
import { caretAt } from '@hhereditas/viewer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openFiles, serialize, withPrimerFeatures } from '../../app/files';
import { nextHitIndex } from '../../app/DocumentWindow';
import { runDigest, fragmentRecord } from '../../features/enzymes/digest';
import { primerFromTemplate } from '../../features/primers/AddPrimerSheet';
import { displayedSites, representatives, SIX_CUTTER_POOL } from '../analysis';
import { HISTORY_LIMIT, pushHistory } from '../history';
import { isDirty } from '../documents';
import { DEFAULT_SETTINGS, parseSettings } from '../settings';
import { getActiveDocument, useApp } from '../store';

const PUC19 = readFileSync(join(__dirname, '../../samples/pUC19.gb'), 'utf8');

function reset() {
  useApp.setState({ documents: [], activeId: null, sheet: null, sheetOptions: {}, closePrompt: null, status: null });
}

function openSeq(seq: string, topology: 'linear' | 'circular' = 'linear') {
  const rec = makeRecord({ seq, topology, name: 'test', features: [makeFeature({ type: 'CDS', name: 'orf', strand: 1, segments: [{ start: 2, end: 8 }] })] });
  useApp.getState().openRecords([rec], { filePath: '/x/test.gb', fileName: 'test.gb', format: 'genbank' });
  return getActiveDocument()!;
}

describe('documents store', () => {
  beforeEach(reset);

  it('opens records and activates the first; re-opening the same path activates it', () => {
    const doc = openSeq('ACGTACGTAC');
    expect(useApp.getState().documents).toHaveLength(1);
    expect(useApp.getState().activeId).toBe(doc.id);
    expect(isDirty(doc)).toBe(false);
    useApp.getState().openRecords([makeRecord({ seq: 'AAA' })], { filePath: '/x/test.gb' });
    expect(useApp.getState().documents).toHaveLength(1);
  });

  it('edits through core ops, remaps features, and becomes dirty', () => {
    openSeq('ACGTACGTAC');
    useApp.getState().applyEdit({ kind: 'insert', gap: 0, bases: 'GG' });
    const doc = getActiveDocument()!;
    expect(doc.record.seq).toBe('GGACGTACGTAC');
    expect(doc.record.features[0].segments[0]).toEqual({ start: 4, end: 10 });
    expect(doc.selection).toEqual(caretAt(2));
    expect(isDirty(doc)).toBe(true);
  });

  it('undoes and redoes, restoring the selection and clean state', () => {
    openSeq('ACGTACGTAC');
    const app = useApp.getState();
    app.setSelection({ range: { start: 3, end: 5 }, caret: 5 });
    app.applyEdit({ kind: 'delete', range: { start: 3, end: 5 } });
    expect(getActiveDocument()!.record.seq).toBe('ACGCGTAC');
    app.undo();
    let doc = getActiveDocument()!;
    expect(doc.record.seq).toBe('ACGTACGTAC');
    expect(doc.selection).toEqual({ range: { start: 3, end: 5 }, caret: 5 });
    expect(isDirty(doc)).toBe(false);
    app.redo();
    doc = getActiveDocument()!;
    expect(doc.record.seq).toBe('ACGCGTAC');
    expect(isDirty(doc)).toBe(true);
    app.redo(); // nothing left: no change
    expect(getActiveDocument()!.record.seq).toBe('ACGCGTAC');
  });

  it('coalesces consecutive typing into one undo step', () => {
    openSeq('AAAA');
    const app = useApp.getState();
    app.applyEdit({ kind: 'insert', gap: 2, bases: 'C' });
    app.applyEdit({ kind: 'insert', gap: 3, bases: 'C' });
    app.applyEdit({ kind: 'insert', gap: 4, bases: 'C' });
    expect(getActiveDocument()!.record.seq).toBe('AACCCAA');
    expect(getActiveDocument()!.history.undo).toHaveLength(1);
    app.undo();
    expect(getActiveDocument()!.record.seq).toBe('AAAA');
  });

  it('a new edit clears the redo stack', () => {
    openSeq('AAAA');
    const app = useApp.getState();
    app.applyEdit({ kind: 'delete', range: { start: 0, end: 1 } });
    app.undo();
    app.applyEdit({ kind: 'delete', range: { start: 3, end: 4 } });
    expect(getActiveDocument()!.history.redo).toHaveLength(0);
  });

  it('feature changes are undoable and deselect deleted items', () => {
    const doc = openSeq('ACGTACGTAC');
    const app = useApp.getState();
    const id = doc.record.features[0].id;
    app.selectItem({ kind: 'feature', id });
    expect(getActiveDocument()!.selection?.range).toEqual({ start: 2, end: 8 });
    app.change((r) => ({ ...r, features: [] }), 'Delete Feature');
    expect(getActiveDocument()!.record.features).toHaveLength(0);
    app.undo();
    expect(getActiveDocument()!.record.features).toHaveLength(1);
    expect(getActiveDocument()!.history.redo[0].label).toBe('Delete Feature');
  });

  it('markSaved makes the document clean; closing activates a neighbour', () => {
    const a = openSeq('ACGT');
    useApp.getState().applyEdit({ kind: 'insert', gap: 0, bases: 'A' });
    const rec = getActiveDocument()!.record;
    useApp.getState().markSaved(a.id, { record: rec, filePath: '/x/a.gb', fileName: 'a.gb', format: 'genbank' });
    expect(isDirty(getActiveDocument()!)).toBe(false);
    useApp.getState().openRecords([makeRecord({ seq: 'TTTT' })]);
    const b = getActiveDocument()!;
    useApp.getState().close(b.id);
    expect(useApp.getState().activeId).toBe(a.id);
    useApp.getState().close(a.id);
    expect(useApp.getState().activeId).toBeNull();
  });

  it('opens a GenBank file through the parser', () => {
    expect(openFiles([{ name: 'pUC19.gb', path: null, data: new TextEncoder().encode(PUC19) }])).toBe(1);
    const doc = getActiveDocument()!;
    expect(doc.record.seq.length).toBe(2686);
    expect(doc.record.topology).toBe('circular');
    expect(doc.format).toBe('genbank');
    expect(doc.view).toBe('map');
  });

  it('reports unreadable files without opening anything', () => {
    expect(openFiles([{ name: 'x.bin', path: null, data: new Uint8Array([0, 1, 2, 255]) }])).toBe(0);
    expect(useApp.getState().status?.tone).toBe('error');
  });
});

describe('history', () => {
  it('drops the oldest steps beyond the limit', () => {
    let h = { undo: [], redo: [] } as Parameters<typeof pushHistory>[0];
    const snap = { record: makeRecord({ seq: 'A' }), selection: null };
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = pushHistory(h, snap, `s${i}`);
    expect(h.undo).toHaveLength(HISTORY_LIMIT);
    expect(h.undo[0].label).toBe('s5');
  });
});

describe('settings', () => {
  it('falls back to defaults for missing or invalid JSON', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{bad')).toEqual(DEFAULT_SETTINGS);
    const s = parseSettings(JSON.stringify({ enzymeDisplay: 'bogus', splitRatio: 7, recentFiles: [{ path: '/a.gb', name: 'a.gb' }, 3] }));
    expect(s.enzymeDisplay).toBe('unique');
    expect(s.splitRatio).toBe(DEFAULT_SETTINGS.splitRatio);
    expect(s.recentFiles).toHaveLength(1);
  });
});

describe('analysis and digest', () => {
  const puc19 = parseAny(PUC19, 'pUC19.gb').records[0];

  it('keeps one name per site among equischizomers', () => {
    const names = new Set(SIX_CUTTER_POOL.map((e) => e.name));
    expect(names.has('EcoRI')).toBe(true);
    expect(representatives(SIX_CUTTER_POOL)).toHaveLength(SIX_CUTTER_POOL.length);
  });

  it('shows unique cutters only by default', () => {
    const sites = displayedSites(puc19, 'unique');
    const names = sites.map((s) => s.enzyme);
    expect(names).toContain('EcoRI');
    expect(new Set(names).size).toBe(names.length);
    expect(displayedSites(puc19, 'none')).toEqual([]);
  });

  it('digests with cut-to-cut sizes that add up to the plasmid', () => {
    const { rows } = runDigest(puc19, ['EcoRI', 'HindIII']);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + r.size, 0)).toBe(2686);
    const frag = fragmentRecord(puc19, rows[0]);
    expect(frag.topology).toBe('linear');
    expect(frag.ends?.left.kind).toBe('5prime');
  });

  it('opens a linearized circle as a fragment with its overhangs', () => {
    const { rows } = runDigest(puc19, ['EcoRI']);
    expect(rows).toHaveLength(1);
    expect(rows[0].size).toBe(2686);
    expect(fragmentRecord(puc19, rows[0]).seq.length).toBe(2690);
  });

  it('writes primers as primer_bind features in GenBank', () => {
    const rec = { ...puc19, primers: [{ id: 'p', name: 'M13F', sequence: 'GTAAAACGACGGCCAGT' }] };
    const out = withPrimerFeatures(rec);
    expect(out.features.some((f) => f.type === 'primer_bind' && f.name === 'M13F')).toBe(true);
    expect(String(serialize(rec, 'genbank').data)).toContain('primer_bind');
  });

  it('takes primer ends from long selections', () => {
    const t = 'A'.repeat(50) + 'C'.repeat(50);
    expect(primerFromTemplate(t, 1)).toBe('A'.repeat(20));
    expect(primerFromTemplate(t, -1)).toBe('G'.repeat(20));
    expect(primerFromTemplate('ACGTT', -1)).toBe('AACGT');
  });

  it('steps through search hits from the caret', () => {
    const hits = [10, 50, 90].map((s) => ({ range: { start: s, end: s + 6 }, strand: 1 as const, mismatches: 0 }));
    expect(nextHitIndex(hits, 40, null, 'next')).toBe(1);
    expect(nextHitIndex(hits, 40, null, 'previous')).toBe(0);
    expect(nextHitIndex(hits, 95, null, 'next')).toBe(0);
    expect(nextHitIndex(hits, 0, 2, 'next')).toBe(0);
  });
});
