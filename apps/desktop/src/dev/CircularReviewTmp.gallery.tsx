/** TEMPORARY interaction-review stories (circular map reviewer); delete after the review. */
import type { Orf, PrimerBindingSite, SeqRecord } from '@hhereditas/core';
import { Profiler, type ReactNode, useEffect, useMemo, useState } from 'react';
import { CircularMap, type CircularMapProps } from '../../../../packages/viewer/src/circular';
import { makeGenome, makeOrf } from '../../../../packages/viewer/src/circular/circularGalleryData';
import { SAMPLES } from '../../../../packages/viewer/src/fixtures';
import type { SequenceSelection } from '../../../../packages/viewer/src/selection';

interface Probe {
  log: unknown[];
  sel: SequenceSelection | null | undefined;
  setSel?: (s: SequenceSelection | null) => void;
  setExtra?: (p: Partial<CircularMapProps>) => void;
  setFrame?: (w: number, h: number) => void;
  remount?: () => void;
  renders: Array<[string, number]>;
}
const w = window as unknown as { __cm?: Probe };
const probe: Probe = (w.__cm ??= { log: [], sel: undefined, renders: [] });
const push = (...entry: unknown[]) => probe.log.push(JSON.parse(JSON.stringify(entry)));

const params = new URLSearchParams(location.search);

function recordFor(name: string): Pick<CircularMapProps, 'record' | 'enzymeSites' | 'primerSites' | 'orfs'> {
  switch (name) {
    case 'pBR322':
    case 'pBAD30':
    case 'linear':
    case 'pFA6a':
      return { record: SAMPLES[name].record, enzymeSites: SAMPLES[name].enzymeSites };
    case 'genome':
      return makeGenome();
    case 'genome4500':
    case 'genome9000': {
      // 4,500 loci evenly spread over 4.64 Mb (optionally gene + CDS pairs, as GenBank files have).
      const base = makeGenome();
      const L = base.record.seq.length;
      const pairs = name === 'genome9000';
      const features: SeqRecord['features'] = [];
      let seed = 11;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      for (let i = 0; i < 4500; i++) {
        const start = Math.floor((i * L) / 4500) + Math.floor(rnd() * 100);
        const len = 300 + Math.floor(rnd() * 900);
        const strand = rnd() < 0.5 ? 1 : -1;
        const nm = `g${i.toString(36)}`;
        features.push({ id: `g${i}`, type: 'gene', name: nm, strand, segments: [{ start, end: start + len }], qualifiers: [] });
        if (pairs) features.push({ id: `c${i}`, type: 'CDS', name: nm, strand, segments: [{ start, end: start + len }], qualifiers: [] });
      }
      return { record: { ...base.record, id: name, features }, enzymeSites: base.enzymeSites };
    }
    case 'empty': {
      const record: SeqRecord = {
        id: 'empty', name: 'Untitled', description: '', seq: '', topology: 'circular', molecule: 'DNA',
        features: [], primers: [], meta: {},
      };
      return { record };
    }
    case 'empty-linear': {
      const record: SeqRecord = {
        id: 'empty', name: 'Untitled', description: '', seq: '', topology: 'linear', molecule: 'DNA',
        features: [], primers: [], meta: {},
      };
      return { record };
    }
    case 'tiny': {
      const record: SeqRecord = {
        id: 'tiny', name: 'tiny', description: '', seq: 'ACGTACGTAC', topology: 'circular', molecule: 'DNA',
        features: [{ id: 'f1', type: 'CDS', name: 'orfA', strand: 1, segments: [{ start: 2, end: 6 }], qualifiers: [] }],
        primers: [], meta: {},
      };
      return { record };
    }
    case 'one': {
      const record: SeqRecord = {
        id: 'one', name: 'one base', description: '', seq: 'A', topology: 'circular', molecule: 'DNA',
        features: [], primers: [], meta: {},
      };
      return { record };
    }
    case 'primers': {
      const base = SAMPLES.pFA6a;
      const record: SeqRecord = {
        ...base.record,
        primers: [
          { id: 'p1', name: 'fwd-A', sequence: 'ACGTACGTACGTACGTACGT' },
          { id: 'p2', name: 'rev-B', sequence: 'ACGTACGTACGTACGTACGT' },
          { id: 'p3', name: 'wrap-C', sequence: 'ACGTACGTACGTACGTACGT' },
        ],
      };
      const site = (primerId: string, start: number, strand: 1 | -1): PrimerBindingSite => ({
        primerId, strand, range: { start, end: start + 20 }, annealedLength: 20, mismatches: 0, tailLength: 0, tm: 60,
      });
      const L = record.seq.length;
      const orfs: Orf[] = [makeOrf(458, 1268, 1, L), makeOrf(3702, 4062, 1, L), makeOrf(2610, 3471, -1, L)];
      return {
        record,
        enzymeSites: base.enzymeSites,
        primerSites: [site('p1', 600, 1), site('p2', 2000, -1), site('p3', L - 10, 1)],
        orfs,
      };
    }
    default:
      return { record: SAMPLES.pFA6a.record, enzymeSites: SAMPLES.pFA6a.enzymeSites };
  }
}

function Harness(): ReactNode {
  const rec = params.get('rec') ?? 'pFA6a';
  const controlled = params.get('ctl') !== '0';
  const data = useMemo(() => recordFor(rec), [rec]);
  const [sel, setSel] = useState<SequenceSelection | null>(null);
  const [extra, setExtra] = useState<Partial<CircularMapProps>>(() => ({
    rotation: params.has('rot') ? Number(params.get('rot')) : undefined,
    highlightedFeatureId: params.get('hl') ?? undefined,
  }));
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(() =>
    params.has('fw') ? { w: Number(params.get('fw')), h: Number(params.get('fh')) } : null,
  );
  const [mountKey, setMountKey] = useState(0);
  probe.sel = controlled ? sel : undefined;
  useEffect(() => {
    probe.setSel = setSel;
    probe.setExtra = (p) => setExtra((e) => ({ ...e, ...p }));
    probe.setFrame = (fw, fh) => setFrame({ w: fw, h: fh });
    probe.remount = () => setMountKey((k) => k + 1);
  }, []);
  const map = (
    <Profiler id="cm" onRender={(_id, phase, ms) => probe.renders.push([phase, ms])}>
    <CircularMap
      key={mountKey}
      {...data}
      {...extra}
      {...(controlled ? { selection: sel } : {})}
      onSelectionChange={(s) => {
        push('sel', s);
        if (controlled) setSel(s);
      }}
      onFeatureClick={(id, info) => push('featureClick', id, info)}
      onFeatureHover={(id) => push('featureHover', id)}
      onEnzymeClick={(site) => push('enzymeClick', site)}
      onPrimerClick={(id) => push('primerClick', id)}
      onContextMenu={(t) => push('contextMenu', t)}
    />
    </Profiler>
  );
  return frame ? (
    <div style={{ padding: 20 }}>
      <div data-testid="frame" style={{ width: frame.w, height: frame.h, border: '1px solid var(--hh-separator)' }}>
        {map}
      </div>
      <input data-testid="after" aria-label="after" />
    </div>
  ) : (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>{map}</div>
      <input data-testid="after" aria-label="after" />
    </div>
  );
}

export default {
  log: () => <Harness />,
} satisfies Record<string, () => ReactNode>;
