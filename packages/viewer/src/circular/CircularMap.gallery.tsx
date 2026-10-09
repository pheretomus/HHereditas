/**
 * Gallery stories for <CircularMap />. Open with
 *   /?gallery=CircularMap&story=<name>[&theme=dark]
 */
import type { EnzymeSite, Feature, Orf, Primer, PrimerBindingSite, SeqRecord } from '@hhereditas/core';
import { type ReactNode, Profiler, useMemo, useState } from 'react';
import { formatBp, formatInt } from '../common/format';
import { SAMPLES } from '../fixtures';
import type { SequenceSelection } from '../selection';
import { CircularMap, type CircularMapProps, formatRangeText } from './CircularMap';
import { cuttingAtMost, makeGenome, makeOrf, scanSites } from './circularGalleryData';
import type { MapTarget } from './types';

type Stories = Record<string, () => ReactNode>;

/** A fixed-size frame centred in the window (for size-specific stories). */
function Frame({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <div
        style={{
          width,
          height,
          border: '0.5px solid var(--hh-separator)',
          borderRadius: 'var(--hh-radius-lg)',
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Stateful wrapper: wires selection, hover and clicks, and shows them in a status line. */
function Playground(
  props: Omit<CircularMapProps, 'selection' | 'onSelectionChange'> & { initial?: SequenceSelection | null },
) {
  const { initial = null, ...rest } = props;
  const [selection, setSelection] = useState<SequenceSelection | null>(initial);
  const [event, setEvent] = useState('Click a feature, drag around the ring, shift+click to extend, Esc to clear.');
  const L = rest.record.seq.length;
  const describe = (t: MapTarget) =>
    t.kind === 'feature' || t.kind === 'primer'
      ? `${t.kind} ${t.id}`
      : t.kind === 'enzyme'
        ? `enzyme ${t.site.enzyme}`
        : t.kind === 'orf'
          ? `ORF ${formatRangeText(t.orf.range, L)}`
          : `${t.kind} @ ${formatInt(t.position)}`;
  const status = selection
    ? selection.range.end > selection.range.start
      ? `Selected ${formatRangeText(selection.range, L)} (${formatBp(selection.range.end - selection.range.start)})`
      : `Caret at ${formatInt(selection.caret)}`
    : 'No selection';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CircularMap
          {...rest}
          selection={selection}
          onSelectionChange={setSelection}
          onFeatureClick={(id, info) =>
            setEvent(`onFeatureClick ${id} ×${info.clickCount}${info.shiftKey ? ' +shift' : ''}`)
          }
          onFeatureHover={(id) => id && setEvent(`onFeatureHover ${id}`)}
          onEnzymeClick={(site) => setEvent(`onEnzymeClick ${site.enzyme} (${site.cuts[0]?.top ?? '–'})`)}
          onPrimerClick={(id) => setEvent(`onPrimerClick ${id}`)}
          onContextMenu={(t) => setEvent(`onContextMenu → ${describe(t)}`)}
        />
      </div>
      <div
        style={{
          display: 'flex',
          gap: 16,
          padding: '6px 12px',
          borderTop: '0.5px solid var(--hh-separator)',
          fontSize: 'var(--hh-text-sm)',
          color: 'var(--hh-text-secondary)',
          background: 'var(--hh-bg-window)',
        }}
      >
        <span data-testid="status" style={{ color: 'var(--hh-text)', fontVariantNumeric: 'tabular-nums' }}>
          {status}
        </span>
        <span>{event}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const pFA6aL = SAMPLES.pFA6a.record.seq.length;

/** Hand-made ORFs on pFA6a (one wraps the origin). */
const pFA6aOrfs: Orf[] = [
  makeOrf(458, 1268, 1, pFA6aL),
  makeOrf(2610, 3471, -1, pFA6aL),
  makeOrf(1092, 1440, -1, pFA6aL),
  makeOrf(612, 903, 1, pFA6aL),
  makeOrf(1980, 2283, 1, pFA6aL),
  makeOrf(3702, 4062, 1, pFA6aL),
  makeOrf(2900, 3230, 1, pFA6aL),
  makeOrf(240, 600, -1, pFA6aL),
];

/** pBAD30 with a few primers and their binding sites. */
const primerDemo = (() => {
  const base = SAMPLES.pBAD30;
  const primers: Primer[] = [
    { id: 'p1', name: 'pBAD-F', sequence: 'ATGCCATAGCATTTTTATCC' },
    { id: 'p2', name: 'pBAD-R', sequence: 'GATTTAATCTGTATCAGG' },
    { id: 'p3', name: 'araC-F', sequence: 'CTGTTTCTCCATACCCGTT' },
    { id: 'p4', name: 'araC-R', sequence: 'GCATAATGTGCCTGTCAAATG' },
    { id: 'p5', name: 'P15A-seq', sequence: 'GGAGCATCACAAACGCTCC' },
    { id: 'p6', name: 'AmpR-mid', sequence: 'CCAACTTACTTCTGACAACG' },
    { id: 'p7', name: 'rrnB-R', sequence: 'GTCGACGGCGCTATTCAGATCC' },
  ];
  const site = (primerId: string, start: number, len: number, strand: 1 | -1, tail = 0, tm = 58.4): PrimerBindingSite => ({
    primerId,
    strand,
    range: { start, end: start + len },
    annealedLength: len,
    mismatches: 0,
    tailLength: tail,
    tm,
  });
  const primerSites: PrimerBindingSite[] = [
    site('p1', 2200, 20, 1),
    site('p2', 2360, 18, -1, 12, 55.1),
    site('p3', 1100, 19, 1),
    site('p4', 1930, 21, -1),
    site('p5', 400, 19, 1, 0, 61.2),
    site('p6', 3300, 20, 1),
    site('p7', 2700, 22, -1),
    { ...site('p1', 2210, 20, 1, 0, 49.8), mismatches: 2 }, // overlapping second hit (second lane)
  ];
  const record: SeqRecord = { ...base.record, primers };
  return { record, enzymeSites: base.enzymeSites, primerSites };
})();

/** pBR322 with every common enzyme (unique and multi-cutters alike). */
const pBR322AllSites = scanSites(SAMPLES.pBR322.record);
const pBR322FewCutters = cuttingAtMost(pBR322AllSites, 2);

function GenomeStory() {
  const genome = useMemo(makeGenome, []);
  return (
    <Profiler id="genome" onRender={recordRender}>
      <Playground record={genome.record} enzymeSites={genome.enzymeSites} />
    </Profiler>
  );
}

function recordRender(_id: string, phase: string, duration: number) {
  const w = window as unknown as { __hhRenders?: Array<[string, number]> };
  (w.__hhRenders ??= []).push([phase, duration]);
}

const emptyRecord: SeqRecord = {
  id: 'empty',
  name: 'Untitled',
  description: '',
  seq: '',
  topology: 'circular',
  molecule: 'DNA',
  features: [],
  primers: [],
  meta: {},
};

const bareRecord: SeqRecord = { ...SAMPLES.pBAD30.record, id: 'bare', name: 'pBAD30 (no annotations)', features: [] };

const longNameRecord: SeqRecord = {
  ...SAMPLES.pFA6a.record,
  id: 'long',
  name: 'pFA6a-kanMX6-GFP(S65T)-tADH1-modified-for-C-terminal-tagging-v2',
};

/** Awkward annotations on a small synthetic plasmid (robustness check). */
const edgeRecord: SeqRecord = (() => {
  const L = 3000;
  const f = (id: string, name: string, type: string, strand: 1 | -1 | 0, segments: Array<[number, number]>): Feature => ({
    id,
    type,
    name,
    strand,
    segments: segments.map(([start, end]) => ({ start, end })),
    qualifiers: [],
  });
  const stack = Array.from({ length: 9 }, (_, i) =>
    f(`stack${i}`, `stack ${i + 1}`, i % 2 ? 'misc_feature' : 'CDS', i % 3 === 0 ? -1 : 1, [[1500 + i * 15, 1900 - i * 10]]),
  );
  return {
    id: 'edge',
    name: 'edge-cases',
    description: '',
    seq: 'ACGT'.repeat(L / 4),
    topology: 'circular',
    molecule: 'DNA',
    primers: [],
    meta: {},
    features: [
      f('whole', 'whole plasmid', 'misc_feature', 0, [[0, L]]),
      f('join', 'joined across origin', 'CDS', 1, [[2700, 3000], [0, 180]]),
      f('split', 'three exons', 'CDS', -1, [[400, 520], [600, 700], [760, 900]]),
      f('zero', 'insertion point', 'misc_feature', 0, [[1000, 1000]]),
      f('nostrand', 'no strand', 'protein_bind', 0, [[1100, 1180]]),
      f('gene', 'dup', 'gene', 1, [[2200, 2500]]),
      f('cds', 'dup', 'CDS', 1, [[2200, 2500]]),
      f('long', 'an annotation with a very long descriptive name that cannot fit anywhere near the map', 'misc_feature', 1, [[1250, 1290]]),
      ...stack,
    ],
  };
})();
const edgeSites: EnzymeSite[] = [
  { enzyme: 'NotI', range: { start: 2996, end: 3004 }, strand: 1, cuts: [{ top: 2998, bottom: 3002 }] },
  { enzyme: 'BaeI', range: { start: 1950, end: 1970 }, strand: 1, cuts: [{ top: 1940, bottom: 1945 }, { top: 1985, bottom: 1980 }] },
  { enzyme: 'Uncut', range: { start: 10, end: 16 }, strand: -1, cuts: [] },
];

const wrapSelection: SequenceSelection = { range: { start: 3700, end: pFA6aL + 260 }, caret: 260 };
const ampR = SAMPLES.pFA6a.record.features.find((f) => f.name === 'AmpR')?.id ?? null;

export default {
  pFA6a: () => <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} />,
  pBAD30: () => <Playground record={SAMPLES.pBAD30.record} enzymeSites={SAMPLES.pBAD30.enzymeSites} />,
  pBR322: () => <Playground record={SAMPLES.pBR322.record} enzymeSites={SAMPLES.pBR322.enzymeSites} />,
  linear: () => <Playground record={SAMPLES.linear.record} enzymeSites={SAMPLES.linear.enzymeSites} />,
  'selection-wrapping-origin': () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} initial={wrapSelection} />
  ),
  caret: () => (
    <Playground
      record={SAMPLES.pFA6a.record}
      enzymeSites={SAMPLES.pFA6a.enzymeSites}
      initial={{ range: { start: 1200, end: 1200 }, caret: 1200 }}
    />
  ),
  'highlighted-feature': () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} highlightedFeatureId={ampR} />
  ),
  /** pBR322 with all its annotations and every common enzyme site (~70 enzymes). */
  'dense-labels': () => <Playground record={SAMPLES.pBR322.record} enzymeSites={pBR322AllSites} />,
  /** What an app filter would usually pass: enzymes cutting once or twice. */
  'few-cutters': () => <Playground record={SAMPLES.pBR322.record} enzymeSites={pBR322FewCutters} />,
  orfs: () => (
    <Playground
      record={SAMPLES.pFA6a.record}
      enzymeSites={SAMPLES.pFA6a.enzymeSites}
      orfs={pFA6aOrfs}
      show={{ orfs: true }}
    />
  ),
  primers: () => (
    <Playground record={primerDemo.record} enzymeSites={primerDemo.enzymeSites} primerSites={primerDemo.primerSites} />
  ),
  'features-only': () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} show={{ enzymes: false }} />
  ),
  rotated: () => <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} rotation={90} />,
  tiny: () => (
    <Frame width={400} height={400}>
      <CircularMap record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} />
    </Frame>
  ),
  'tiny-dense': () => (
    <Frame width={400} height={400}>
      <CircularMap record={SAMPLES.pBR322.record} enzymeSites={SAMPLES.pBR322.enzymeSites} />
    </Frame>
  ),
  large: () => (
    <Frame width={1500} height={950}>
      <CircularMap record={primerDemo.record} enzymeSites={primerDemo.enzymeSites} primerSites={primerDemo.primerSites} />
    </Frame>
  ),
  'long-name': () => <Playground record={longNameRecord} enzymeSites={SAMPLES.pFA6a.enzymeSites} />,
  /** Whole-circle, origin-spanning join, zero-length, strandless, duplicate and deeply stacked features. */
  'edge-cases': () => <Playground record={edgeRecord} enzymeSites={edgeSites} />,
  'no-features': () => <Playground record={bareRecord} />,
  empty: () => <Playground record={emptyRecord} />,
  genome: () => <GenomeStory />,
  'perf-pBR322': () => (
    <Profiler id="pBR322" onRender={recordRender}>
      <Playground record={SAMPLES.pBR322.record} enzymeSites={SAMPLES.pBR322.enzymeSites} />
    </Profiler>
  ),
} satisfies Stories;
