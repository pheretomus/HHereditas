/**
 * Gallery stories for <CircularMap />. Open with
 *   /?gallery=CircularMap&story=<name>[&theme=dark]
 */
import type { EnzymeSite, Feature, Orf, Primer, PrimerBindingSite, SeqRecord, Strand } from '@hhereditas/core';
import { type ReactNode, Profiler, useMemo, useState } from 'react';
import { formatBp } from '../common/format';
import { SAMPLES } from '../fixtures';
import type { SequenceSelection } from '../selection';
import { CircularMap, type CircularMapProps, formatRangeText } from './CircularMap';
import type { MapTarget } from './types';

type Stories = Record<string, () => ReactNode>;

function Fill({ children }: { children: ReactNode }) {
  return <div style={{ width: '100%', height: '100%' }}>{children}</div>;
}

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
function Playground(props: Omit<CircularMapProps, 'selection' | 'onSelectionChange'> & { initial?: SequenceSelection | null }) {
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
          : `${t.kind} @ ${t.position}`;
  const status = selection
    ? selection.range.end > selection.range.start
      ? `Selected ${formatRangeText(selection.range, L)} (${formatBp(selection.range.end - selection.range.start)})`
      : `Caret at ${selection.caret}`
    : 'No selection';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CircularMap
          {...rest}
          selection={selection}
          onSelectionChange={setSelection}
          onFeatureClick={(id, info) => setEvent(`onFeatureClick ${id} ×${info.clickCount}${info.shiftKey ? ' +shift' : ''}`)}
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
// Data helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function orf(start: number, end: number, strand: 1 | -1, L: number, hasStop = true): Orf {
  const frame = (strand === 1 ? start % 3 : (L - end) % 3) as 0 | 1 | 2;
  return { range: { start, end }, strand, frame, aaLength: Math.floor((end - start) / 3) - (hasStop ? 1 : 0), hasStop };
}

const pFA6aOrfs: Orf[] = (() => {
  const L = SAMPLES.pFA6a.record.seq.length;
  return [
    orf(458, 1268, 1, L),
    orf(2610, 3471, -1, L),
    orf(1092, 1440, -1, L),
    orf(612, 903, 1, L),
    orf(1980, 2283, 1, L),
    orf(3702, 4062, 1, L), // wraps the origin
    orf(2900, 3230, 1, L),
    orf(240, 600, -1, L),
  ];
})();

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
    site('p1', 2210, 20, 1, 0, 49.8), // overlapping second hit (stacks on a second lane)
  ];
  const record: SeqRecord = { ...base.record, primers };
  return { record, enzymeSites: base.enzymeSites, primerSites };
})();

/** A synthetic 4.6 Mb bacterial genome with ~4,500 features (performance story). */
function makeGenome(): { record: SeqRecord; enzymeSites: EnzymeSite[] } {
  const L = 4_641_652;
  const rand = rng(7);
  const chunk = 'ACGTTGCAAGCTTGGATCCGAATTCTGCAGGTACCATGGCTAGCTCGAGT';
  const seq = chunk.repeat(Math.ceil(L / chunk.length)).slice(0, L);
  const features: Feature[] = [];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let pos = 190;
  let n = 0;
  while (pos < L - 3000 && features.length < 4500) {
    const len = 300 + Math.floor(rand() * 2400);
    const strand: Strand = rand() < 0.5 ? 1 : -1;
    const name = `${letters[Math.floor(rand() * 26)]}${letters[Math.floor(rand() * 26)]}${letters[Math.floor(rand() * 26)]}${String.fromCharCode(65 + (n % 26))}`;
    const type = rand() < 0.02 ? 'rRNA' : rand() < 0.03 ? 'tRNA' : 'CDS';
    features.push({
      id: `g${n}`,
      type,
      name,
      strand,
      segments: [{ start: pos, end: pos + len }],
      qualifiers: [{ key: 'gene', value: name }],
    });
    // Occasional overlapping regulatory annotations.
    if (rand() < 0.08) {
      features.push({
        id: `r${n}`,
        type: 'promoter',
        name: `P${name}`,
        strand,
        segments: [{ start: Math.max(0, pos - 80), end: pos + 20 }],
        qualifiers: [],
      });
    }
    pos += len + Math.floor(rand() * 400) - 60;
    n++;
  }
  const enzymeSites: EnzymeSite[] = ['NotI', 'SfiI', 'AscI', 'PacI', 'SwaI', 'PmeI', 'SrfI', 'FseI'].flatMap((enzyme, i) =>
    Array.from({ length: i < 4 ? 1 : 2 }, (_, k) => {
      const start = Math.floor(rand() * (L - 10));
      return { enzyme, range: { start, end: start + 8 }, strand: 1 as const, cuts: [{ top: start + 2 + k, bottom: start + 6 }] };
    }),
  );
  return {
    record: {
      id: 'genome',
      name: 'Escherichia coli K-12 (synthetic)',
      description: '',
      seq,
      topology: 'circular',
      molecule: 'DNA',
      features,
      primers: [],
      meta: {},
    },
    enzymeSites,
  };
}

function GenomeStory() {
  const genome = useMemo(makeGenome, []);
  return (
    <Profiler
      id="genome"
      onRender={(_id, phase, duration) => {
        (window as unknown as { __hhRenders?: Array<[string, number]> }).__hhRenders ??= [];
        (window as unknown as { __hhRenders: Array<[string, number]> }).__hhRenders.push([phase, duration]);
      }}
    >
      <Playground record={genome.record} enzymeSites={genome.enzymeSites} />
    </Profiler>
  );
}

function PerfStory() {
  return (
    <Profiler
      id="pBR322"
      onRender={(_id, phase, duration) => {
        (window as unknown as { __hhRenders?: Array<[string, number]> }).__hhRenders ??= [];
        (window as unknown as { __hhRenders: Array<[string, number]> }).__hhRenders.push([phase, duration]);
      }}
    >
      <Playground record={SAMPLES.pBR322.record} enzymeSites={SAMPLES.pBR322.enzymeSites} />
    </Profiler>
  );
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

const pFA6aL = SAMPLES.pFA6a.record.seq.length;
const wrapSelection: SequenceSelection = { range: { start: 3700, end: pFA6aL + 260 }, caret: 260 };

export default {
  pFA6a: () => (
    <Fill>
      <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} />
    </Fill>
  ),
  pBAD30: () => (
    <Fill>
      <Playground record={SAMPLES.pBAD30.record} enzymeSites={SAMPLES.pBAD30.enzymeSites} />
    </Fill>
  ),
  pBR322: () => (
    <Fill>
      <Playground record={SAMPLES.pBR322.record} enzymeSites={SAMPLES.pBR322.enzymeSites} />
    </Fill>
  ),
  linear: () => (
    <Fill>
      <Playground record={SAMPLES.linear.record} enzymeSites={SAMPLES.linear.enzymeSites} />
    </Fill>
  ),
  'selection-wrapping-origin': () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} initial={wrapSelection} />
  ),
  caret: () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} initial={{ range: { start: 1200, end: 1200 }, caret: 1200 }} />
  ),
  'highlighted-feature': () => (
    <Playground
      record={SAMPLES.pFA6a.record}
      enzymeSites={SAMPLES.pFA6a.enzymeSites}
      highlightedFeatureId={SAMPLES.pFA6a.record.features.find((f) => f.name === 'AmpR')?.id ?? null}
    />
  ),
  'dense-labels': () => (
    <Playground record={SAMPLES.pBR322.record} enzymeSites={SAMPLES.pBR322.enzymeSites} />
  ),
  orfs: () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} orfs={pFA6aOrfs} />
  ),
  primers: () => (
    <Playground record={primerDemo.record} enzymeSites={primerDemo.enzymeSites} primerSites={primerDemo.primerSites} />
  ),
  'features-only': () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} show={{ enzymes: false }} />
  ),
  rotated: () => (
    <Playground record={SAMPLES.pFA6a.record} enzymeSites={SAMPLES.pFA6a.enzymeSites} rotation={90} />
  ),
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
      <CircularMap record={SAMPLES.pBAD30.record} enzymeSites={SAMPLES.pBAD30.enzymeSites} orfs={[]} />
    </Frame>
  ),
  'long-name': () => (
    <Playground record={longNameRecord} enzymeSites={SAMPLES.pFA6a.enzymeSites} />
  ),
  'no-features': () => (
    <Playground record={bareRecord} />
  ),
  empty: () => (
    <Playground record={emptyRecord} />
  ),
  genome: () => <GenomeStory />,
  'perf-pBR322': () => <PerfStory />,
} satisfies Stories;
