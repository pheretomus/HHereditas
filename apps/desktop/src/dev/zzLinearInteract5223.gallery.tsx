/** TEMPORARY interaction-review stories (linear map reviewer, port 5223); delete after the review. */
import type { EnzymeSite, Orf, PrimerBindingSite, Range, SeqRecord } from '@hhereditas/core';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { SAMPLES } from '../../../../packages/viewer/src/fixtures';
import type { MapShowOptions } from '../../../../packages/viewer/src/linear';
import { LinearMap, fullViewport } from '../../../../packages/viewer/src/linear';
import { demoOrfs, demoPrimers, syntheticGenome } from '../../../../packages/viewer/src/linear/galleryData';
import type { SequenceSelection } from '../../../../packages/viewer/src/selection';

interface LogEntry {
  t: number;
  name: string;
  args: unknown[];
}
interface Hooks {
  log: LogEntry[];
  renders: number;
  setSel?: (s: SequenceSelection | null) => void;
  setVp?: (v: Range) => void;
  setHl?: (id: string | null) => void;
  setShow?: (s: MapShowOptions | undefined) => void;
  setWidth?: (w: string) => void;
  setWhich?: (k: string) => void;
  state?: () => { sel: SequenceSelection | null; vp: Range | null };
}
declare global {
  interface Window {
    __lm?: Hooks;
  }
}

function hooks(): Hooks {
  if (!window.__lm) window.__lm = { log: [], renders: 0 };
  return window.__lm;
}
function log(name: string, ...args: unknown[]) {
  hooks().log.push({ t: performance.now(), name, args: JSON.parse(JSON.stringify(args ?? null)) as unknown[] });
}

interface Data {
  record: SeqRecord;
  enzymeSites?: EnzymeSite[];
  primerSites?: PrimerBindingSite[];
  orfs?: Orf[];
}

function linearData(): Data {
  const { record, primerSites } = demoPrimers(SAMPLES.linear.record, [
    { name: 'CMV-F', start: 300, end: 320, strand: 1, tm: 58.4 },
    { name: 'DsRed-rev-XhoI', start: 1180, end: 1201, strand: -1, tail: 'CCGCTCGAG', tm: 63.0 },
  ]);
  return {
    record,
    primerSites,
    orfs: demoOrfs(record.seq, 100),
    enzymeSites: SAMPLES.linear.enzymeSites.filter((s) => ['EcoRI', 'XhoI', 'NotI', 'KpnI', 'SpeI', 'NheI', 'BglII', 'HpaI'].includes(s.enzyme)),
  };
}

const TINY: SeqRecord = {
  id: 'tiny10',
  name: 'tiny10',
  description: '',
  seq: 'ACGTACGTAA',
  topology: 'linear',
  molecule: 'DNA',
  features: [{ id: 'tf', type: 'CDS', name: 'mini', strand: 1, segments: [{ start: 2, end: 6 }], qualifiers: [] }],
  primers: [],
  meta: {},
};
const TINY_CIRC: SeqRecord = { ...TINY, id: 'tinyc', name: 'tinyc', topology: 'circular' };
const ONE: SeqRecord = { ...TINY, id: 'one', name: 'one', seq: 'A', features: [] };
const EMPTY: SeqRecord = { id: 'empty', name: 'Empty', description: '', seq: '', topology: 'linear', molecule: 'DNA', features: [], primers: [], meta: {} };

function dataFor(which: string): Data {
  switch (which) {
    case 'linear':
      return linearData();
    case 'pFA6a':
      return { record: SAMPLES.pFA6a.record, enzymeSites: SAMPLES.pFA6a.enzymeSites };
    case 'pBR322':
      return { record: SAMPLES.pBR322.record, enzymeSites: SAMPLES.pBR322.enzymeSites };
    case 'genome': {
      const g = syntheticGenome();
      return { record: g.record, enzymeSites: g.enzymeSites };
    }
    case 'tiny':
      return { record: TINY };
    case 'tinyc':
      return { record: TINY_CIRC };
    case 'one':
      return { record: ONE };
    default:
      return { record: EMPTY };
  }
}

function Host({
  which: initialWhich,
  controlSel = true,
  controlVp = true,
  initialVp,
  initialSel = null,
  frozenVp,
  frozenSel,
}: {
  which: string;
  controlSel?: boolean;
  controlVp?: boolean;
  initialVp?: Range;
  initialSel?: SequenceSelection | null;
  /** A parent that ignores onViewportChange. */
  frozenVp?: Range;
  /** A parent that ignores onSelectionChange. */
  frozenSel?: SequenceSelection | null;
}) {
  const [which, setWhich] = useState(initialWhich);
  const d = useMemo(() => dataFor(which), [which]);
  const L = d.record.seq.length;
  const [sel, setSel] = useState<SequenceSelection | null>(initialSel);
  const [vp, setVp] = useState<Range>(initialVp ?? fullViewport(L));
  const [hl, setHl] = useState<string | null>(null);
  const [show, setShow] = useState<MapShowOptions | undefined>(undefined);
  const [width, setWidth] = useState('100%');
  hooks().renders++;
  useEffect(() => {
    const h = hooks();
    h.setSel = setSel;
    h.setVp = setVp;
    h.setHl = setHl;
    h.setShow = setShow;
    h.setWidth = setWidth;
    h.setWhich = (k: string) => {
      setWhich(k);
      setVp(fullViewport(dataFor(k).record.seq.length));
      setSel(null);
    };
  }, []);
  useEffect(() => {
    hooks().state = () => ({ sel: controlSel ? sel : null, vp: controlVp ? vp : null });
  });
  const selectionProps =
    frozenSel !== undefined
      ? { selection: frozenSel }
      : controlSel
        ? { selection: sel }
        : {};
  const viewportProps = frozenVp !== undefined ? { viewport: frozenVp } : controlVp ? { viewport: vp } : {};
  return (
    <div style={{ height: '100%', width }} data-testid="host">
      <LinearMap
        record={d.record}
        enzymeSites={d.enzymeSites}
        primerSites={d.primerSites}
        orfs={d.orfs}
        highlightedFeatureId={hl}
        show={show}
        {...selectionProps}
        {...viewportProps}
        onSelectionChange={(s) => {
          log('selection', s);
          if (controlSel && frozenSel === undefined) setSel(s);
        }}
        onViewportChange={(v) => {
          log('viewport', v);
          if (controlVp && frozenVp === undefined) setVp(v);
        }}
        onFeatureClick={(id, info) => log('featureClick', id, info)}
        onFeatureHover={(id) => log('featureHover', id)}
        onEnzymeClick={(s) => log('enzymeClick', s)}
        onPrimerClick={(id) => log('primerClick', id)}
        onContextMenu={(t, e) => log('contextMenu', t, { x: e.clientX, y: e.clientY, defaultPrevented: e.defaultPrevented })}
      />
    </div>
  );
}

/** Generates the genome first (timed), then mounts the map and records when its SVG appears. */
function GenomeTimed({ controlled }: { controlled: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const h = hooks() as Hooks & { genMs?: number; mountT0?: number };
    const t0 = performance.now();
    syntheticGenome();
    h.genMs = performance.now() - t0;
    const id = window.setTimeout(() => {
      h.mountT0 = performance.now();
      setReady(true);
    }, 300);
    return () => window.clearTimeout(id);
  }, []);
  if (!ready) return <div data-testid="waiting">generating…</div>;
  return controlled ? <Host which="genome" /> : <Host which="genome" controlSel={false} controlVp={false} />;
}

const stories: Record<string, () => ReactNode> = {
  'genome-timed': () => <GenomeTimed controlled />,
  'genome-timed-unctl': () => <GenomeTimed controlled={false} />,
  'linear-ctl': () => <Host which="linear" />,
  'linear-unctl': () => <Host which="linear" controlSel={false} controlVp={false} />,
  'circ-ctl': () => <Host which="pFA6a" />,
  'circ-unctl': () => <Host which="pFA6a" controlSel={false} controlVp={false} />,
  'pbr-ctl': () => <Host which="pBR322" />,
  'genome-ctl': () => <Host which="genome" />,
  'genome-unctl': () => <Host which="genome" controlSel={false} controlVp={false} />,
  'tiny-ctl': () => <Host which="tiny" />,
  'tinyc-ctl': () => <Host which="tinyc" />,
  'one-ctl': () => <Host which="one" />,
  'empty-ctl': () => <Host which="empty" />,
  'empty-unctl': () => <Host which="empty" controlSel={false} controlVp={false} />,
  'frozen-vp': () => <Host which="linear" frozenVp={{ start: 1000, end: 3000 }} />,
  'frozen-sel': () => <Host which="pFA6a" frozenSel={null} />,
};

export default stories;
