/**
 * Gallery stories for <LinearMap />. View one with
 *   /?gallery=LinearMap&story=<name>   (add &theme=dark for dark mode)
 */
import type { Range, SeqRecord } from '@hhereditas/core';
import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { formatBp, formatInt } from '../common/format';
import { SAMPLES } from '../fixtures';
import type { SequenceSelection } from '../selection';
import { selectRange } from '../selection';
import { demoGeneLocus, demoOrfs, demoPrimers, syntheticGenome } from './galleryData';
import type { LinearMapProps } from './LinearMap';
import { LinearMap } from './LinearMap';
import { fullViewport, viewportForRange } from './viewport';

type Stories = Record<string, () => ReactNode>;

const fill: CSSProperties = { height: '100%' };

function Full(props: LinearMapProps) {
  return (
    <div style={fill}>
      <LinearMap {...props} />
    </div>
  );
}

const statusBar: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'center',
  height: 'var(--hh-statusbar-height)',
  padding: '0 12px',
  borderTop: '1px solid var(--hh-separator)',
  background: 'var(--hh-bg-window)',
  color: 'var(--hh-text-secondary)',
  fontSize: 'var(--hh-text-sm)',
  fontVariantNumeric: 'tabular-nums',
  flex: 'none',
};

const button: CSSProperties = {
  height: 20,
  padding: '0 8px',
  border: 'none',
  borderRadius: 'var(--hh-radius-xs)',
  background: 'var(--hh-bg-control)',
  boxShadow: 'var(--hh-shadow-control)',
  color: 'var(--hh-text)',
  fontSize: 'var(--hh-text-sm)',
};

/** Stateful host: controlled selection and viewport, like the app. */
function Interactive({
  record,
  initialSelection = null,
  initialViewport,
  ...rest
}: Omit<LinearMapProps, 'selection' | 'onSelectionChange' | 'viewport' | 'onViewportChange'> & {
  initialSelection?: SequenceSelection | null;
  initialViewport?: Range;
}) {
  const [selection, setSelection] = useState<SequenceSelection | null>(initialSelection);
  const [viewport, setViewport] = useState<Range>(initialViewport ?? fullViewport(record.seq.length));
  const [hovered, setHovered] = useState<string | null>(null);
  const [last, setLast] = useState('');
  const L = record.seq.length;
  const sel = selection
    ? selection.range.end > selection.range.start
      ? `${formatInt(selection.range.start + 1)}..${formatInt(selection.range.end > L ? selection.range.end - L : selection.range.end)} (${formatBp(selection.range.end - selection.range.start)})`
      : `caret at ${formatInt(selection.caret)}`
    : 'no selection';
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <LinearMap
          record={record}
          selection={selection}
          onSelectionChange={setSelection}
          viewport={viewport}
          onViewportChange={setViewport}
          onFeatureHover={setHovered}
          onFeatureClick={(id, info) => setLast(`feature ${id} ×${info.clickCount}${info.shiftKey ? ' ⇧' : ''}`)}
          onEnzymeClick={(s) => setLast(`enzyme ${s.enzyme}`)}
          onPrimerClick={(id) => setLast(`primer ${id}`)}
          onContextMenu={(t) => setLast(`context ${t.kind}`)}
          {...rest}
        />
      </div>
      <div style={statusBar} data-testid="status">
        <span data-testid="status-selection">{sel}</span>
        <span data-testid="status-viewport">
          view {formatInt(Math.round(viewport.start))}–{formatInt(Math.round(viewport.end))}
        </span>
        <span data-testid="status-hover">{hovered ?? ''}</span>
        <span data-testid="status-last">{last}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={button}
          onClick={() => selection && setViewport(viewportForRange(selection.range, L, record.topology))}
        >
          Zoom to selection
        </button>
        <button type="button" style={button} onClick={() => setViewport(fullViewport(L))}>
          Zoom to fit
        </button>
      </div>
    </div>
  );
}

function withPrimersAndOrfs(): { record: SeqRecord; primerSites: LinearMapProps['primerSites']; orfs: LinearMapProps['orfs'] } {
  const { record, primerSites } = demoPrimers(SAMPLES.linear.record, [
    { name: 'CMV-F', start: 300, end: 320, strand: 1, tm: 58.4 },
    { name: 'DsRed-fwd-EcoRI', start: 540, end: 562, strand: 1, tail: 'GCGGAATTC', tm: 61.2 },
    { name: 'DsRed-rev-XhoI', start: 1180, end: 1201, strand: -1, tail: 'CCGCTCGAG', tm: 63.0 },
    { name: 'CmR-seq', start: 2100, end: 2120, strand: 1, tm: 57.1 },
    { name: 'WPRE-R', start: 2812, end: 2833, strand: -1, tm: 59.9 },
    { name: 'ori-R', start: 4198, end: 4218, strand: -1, tm: 60.3 },
    { name: 'Amp-F (1 mm)', start: 5500, end: 5520, strand: 1, mismatches: 1, tm: 55.8 },
    { name: 'CMV-enh-F', start: 6200, end: 6221, strand: 1, tm: 60.1 },
    { name: 'RRE-R', start: 7700, end: 7720, strand: -1, tm: 58.0 },
  ]);
  return { record, primerSites, orfs: demoOrfs(record.seq, 100) };
}

const stories: Stories = {
  'pFA6a-kanMX6': () => <Full record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} />,
  pBAD30: () => <Full record={SAMPLES.pBAD30.record} enzymeSites={SAMPLES.pBAD30.enzymeSites} />,
  pBR322: () => <Full record={SAMPLES.pBR322.record} enzymeSites={SAMPLES.pBR322.enzymeSites} />,
  linear: () => <Full record={SAMPLES.linear.record} enzymeSites={SAMPLES.linear.enzymeSites} />,
  'features-only': () => <Full record={SAMPLES.linear.record} />,
  'exons-introns': () => <Full record={demoGeneLocus()} />,
  'primers-orfs': () => {
    const d = withPrimersAndOrfs();
    return <Full record={d.record} primerSites={d.primerSites} orfs={d.orfs} enzymeSites={SAMPLES.linear.enzymeSites.filter((s) => ['EcoRI', 'XhoI', 'NotI', 'KpnI', 'SpeI', 'NheI'].includes(s.enzyme))} />;
  },
  'zoomed-bases': () => (
    <Full
      record={SAMPLES.pFA6a.record}
      enzymeSites={SAMPLES.pFA6a.enzymeSites}
      viewport={{ start: 22, end: 86 }}
      selection={selectRange({ start: 42, end: 48 }, SAMPLES.pFA6a.record.seq.length, 'circular')}
    />
  ),
  'zoomed-features': () => (
    <Full record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} viewport={{ start: 300, end: 1700 }} />
  ),
  selection: () => (
    <Full
      record={SAMPLES.pFA6a.record}
      enzymeSites={SAMPLES.pFA6a.enzymeSites}
      selection={selectRange({ start: 458, end: 1268 }, SAMPLES.pFA6a.record.seq.length, 'circular')}
      highlightedFeatureId="pFA6a-kanMX6_f9"
    />
  ),
  'selection-wraps-origin': () => (
    <Full
      record={SAMPLES.pFA6a.record}
      enzymeSites={SAMPLES.pFA6a.enzymeSites}
      selection={selectRange({ start: 3700, end: 3938 + 260 }, SAMPLES.pFA6a.record.seq.length, 'circular')}
    />
  ),
  caret: () => (
    <Full record={SAMPLES.pBAD30.record} enzymeSites={SAMPLES.pBAD30.enzymeSites} selection={{ range: { start: 2285, end: 2285 }, caret: 2285 }} />
  ),
  'genome-4.6Mb': () => {
    const g = syntheticGenome();
    return <Full record={g.record} enzymeSites={g.enzymeSites} />;
  },
  'genome-60kb': () => {
    const g = syntheticGenome();
    return <Full record={g.record} enzymeSites={g.enzymeSites} viewport={{ start: 1_200_000, end: 1_260_000 }} />;
  },
  'genome-interactive': () => {
    const g = syntheticGenome();
    return <Interactive record={g.record} enzymeSites={g.enzymeSites} />;
  },
  interactive: () => <InteractiveSample />,
  'interactive-circular': () => (
    <Interactive record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} />
  ),
  tiny: () => (
    <Full
      record={{
        id: 'oligo',
        name: 'oligo',
        description: '',
        seq: 'GAATTCATGGTGAGCAAGGGCGAGGAGCTGTTCACCGG',
        topology: 'linear',
        molecule: 'DNA',
        features: [{ id: 'k', type: 'CDS', name: 'start', strand: 1, segments: [{ start: 6, end: 30 }], qualifiers: [] }],
        primers: [],
        meta: {},
      }}
      enzymeSites={[{ enzyme: 'EcoRI', range: { start: 0, end: 6 }, strand: 1, cuts: [{ top: 1, bottom: 5 }] }]}
    />
  ),
  'sticky-ends': () => (
    <Full
      record={{
        id: 'frag',
        name: 'EcoRI–XhoI fragment',
        description: '',
        seq: 'AATTCATGGTGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGCGACGTAAACGGC',
        topology: 'linear',
        molecule: 'DNA',
        features: [{ id: 'k', type: 'CDS', name: 'EGFP (5′)', strand: 1, segments: [{ start: 5, end: 80 }], qualifiers: [] }],
        primers: [],
        ends: { left: { kind: '5prime', length: 4 }, right: { kind: '5prime', length: 4 } },
        meta: {},
      }}
      viewport={{ start: 0, end: 48 }}
    />
  ),
  protein: () => (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: '1fr 1fr' }}>
      <LinearMap
        record={{
          id: 'egfp-protein',
          name: 'EGFP',
          description: '',
          seq: 'MVSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITLGMDELYK*',
          topology: 'linear',
          molecule: 'protein',
          features: [
            { id: 'a', type: 'misc_feature', name: 'β-barrel', strand: 0, segments: [{ start: 10, end: 230 }], qualifiers: [] },
            { id: 'b', type: 'misc_feature', name: 'Chromophore', strand: 0, segments: [{ start: 64, end: 67 }], qualifiers: [] },
          ],
          primers: [],
          meta: {},
        }}
      />
      <LinearMap
        record={{
          id: 'rna',
          name: 'sgRNA',
          description: '',
          seq: 'GUUUUAGAGCUAGAAAUAGCAAGUUAAAAUAAGGCUAGUCCGUUAUCAACUUGAAAAAGUGGCACCGAGUCGGUGCUUUU',
          topology: 'linear',
          molecule: 'RNA',
          features: [{ id: 'r', type: 'misc_RNA', name: 'scaffold', strand: 1, segments: [{ start: 0, end: 76 }], qualifiers: [] }],
          primers: [],
          meta: {},
        }}
      />
    </div>
  ),
  empty: () => (
    <Full record={{ id: 'empty', name: 'Empty', description: '', seq: '', topology: 'linear', molecule: 'DNA', features: [], primers: [], meta: {} }} />
  ),
};

function InteractiveSample() {
  const d = useMemo(withPrimersAndOrfs, []);
  return (
    <Interactive
      record={d.record}
      primerSites={d.primerSites}
      orfs={d.orfs}
      enzymeSites={SAMPLES.linear.enzymeSites.filter((s) => ['EcoRI', 'XhoI', 'NotI', 'KpnI', 'SpeI', 'NheI', 'BglII', 'HpaI'].includes(s.enzyme))}
    />
  );
}

export default stories;
