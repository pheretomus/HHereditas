/**
 * Gallery stories for <GelView /> and <GelThumbnail />.
 * View: /?gallery=GelView&story=digest (add &theme=dark).
 *
 * Band data is hand-made: fragment sizes of classic digests, positioned with a semi-log migration
 * formula (logistic in log10(size), calibrated on the tracking dyes like the core gel model) and
 * intensities proportional to DNA mass.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { GelThumbnail } from './GelThumbnail';
import { GelView } from './GelView';
import { formatGelSize } from './format';
import type { GelLane, GelLaneBand, GelSizeLabels } from './types';

// ---------------------------------------------------------------------------------------------
// Semi-log migration formula
// ---------------------------------------------------------------------------------------------

/** [agarose %, bp co-migrating with bromophenol blue, with xylene cyanol FF] (TAE). */
const DYES: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 1150, 16700], [0.7, 660, 8500], [0.8, 530, 6500], [1.0, 370, 4160],
  [1.2, 275, 2890], [1.5, 190, 1840], [2.0, 120, 1040],
];

/** position(size) = top + span / (1 + (size / mid)^k), fitted through the two dye fronts. */
function migration(agarose: number): (size: number) => number {
  let i = 0;
  while (i < DYES.length - 2 && agarose > DYES[i + 1][0]) i++;
  const [p0, b0, x0] = DYES[i];
  const [p1, b1, x1] = DYES[i + 1];
  const t = Math.min(1, Math.max(0, (agarose - p0) / (p1 - p0)));
  const lerpLog = (a: number, b: number) => 10 ** (Math.log10(a) + t * (Math.log10(b) - Math.log10(a)));
  const bpb = lerpLog(b0, b1);
  const xc = lerpLog(x0, x1);
  const k = 1.12;
  const bottom = 0.9;
  const front = 0.775;
  const front2 = front / 2.2;
  const r = (xc / bpb) ** k;
  const u = ((bottom - front) * (r - 1)) / (front - front2) - 1;
  const uu = u / r;
  const span = ((bottom - front) * (1 + uu)) / uu;
  const mid = bpb / uu ** (1 / k);
  return (size) => bottom - span + span / (1 + (size / mid) ** k);
}

interface Fragment {
  size: number;
  label?: string;
  /** Relative molar amount (default 1). */
  amount?: number;
  form?: 'linear' | 'supercoiled' | 'nicked';
}

const FORM_FACTOR = { linear: 1, supercoiled: 0.7, nicked: 1.6 } as const;

/** A sample lane: fragments positioned on the gel, co-migrating ones merged, intensity ∝ mass. */
function sample(id: string, label: string, fragments: readonly Fragment[], agarose = 1, resolution = 0.007): GelLane {
  const pos = migration(agarose);
  const items = fragments
    .map((f) => ({
      size: f.size,
      position: pos(f.size * FORM_FACTOR[f.form ?? 'linear']),
      mass: f.size * (f.amount ?? 1),
      label: f.label,
    }))
    .sort((a, b) => a.position - b.position);
  const groups: (typeof items)[] = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    if (g && it.position - g[g.length - 1].position < resolution) g.push(it);
    else groups.push([it]);
  }
  const maxMass = Math.max(...groups.map((g) => g.reduce((m, it) => m + it.mass, 0)));
  return {
    id,
    label,
    kind: 'sample',
    bands: groups.map((g): GelLaneBand => {
      const mass = g.reduce((m, it) => m + it.mass, 0);
      return {
        size: g.length === 1 ? g[0].size : g.reduce((s, it) => s + it.mass * it.size, 0) / mass,
        position: g.reduce((s, it) => s + it.mass * it.position, 0) / mass,
        intensity: mass / maxMass,
        count: g.length,
        labels: g.flatMap((it) => (it.label ? [it.label] : [])),
        sizes: g.map((it) => it.size).sort((a, b) => b - a),
      };
    }),
  };
}

type LadderRow = readonly [size: number, massNg: number, emphasized?: boolean];

function ladder(id: string, label: string, rows: readonly LadderRow[], agarose = 1): GelLane {
  const pos = migration(agarose);
  const maxMass = Math.max(...rows.map((r) => r[1]));
  return {
    id,
    label,
    kind: 'ladder',
    bands: rows.map(([size, massNg, emphasized]) => ({
      size,
      position: pos(size),
      intensity: massNg / maxMass,
      massNg,
      emphasized: emphasized === true,
    })),
  };
}

const E = true;

const ONE_KB_PLUS: readonly LadderRow[] = [
  [20000, 20], [10000, 20], [7000, 20], [5000, 75, E], [4000, 20], [3000, 20], [2000, 20],
  [1500, 80, E], [1000, 25], [700, 25], [500, 75, E], [400, 25], [300, 25], [200, 25], [75, 25],
];

const HUNDRED_BP: readonly LadderRow[] = [
  [1517, 45], [1200, 35], [1000, 95, E], [900, 27], [800, 24], [700, 21], [600, 18],
  [517, 97, E], [400, 38], [300, 29], [200, 25], [100, 48],
];

/** GeneRuler-style DNA ladder mix: 21 bands from 10 kb to 100 bp. */
const LADDER_MIX: readonly LadderRow[] = [
  [10000, 30], [8000, 30], [6000, 70, E], [5000, 30], [4000, 30], [3500, 30], [3000, 70, E],
  [2500, 25], [2000, 25], [1500, 25], [1200, 25], [1000, 60, E], [900, 20], [800, 20],
  [700, 20], [600, 20], [500, 60, E], [400, 20], [300, 20], [200, 20], [100, 20],
];

/** Circular-digest fragment list with labels "Enzyme (start) – Enzyme (end)". */
function circularDigest(length: number, cuts: ReadonlyArray<readonly [number, string]>): Fragment[] {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  if (sorted.length === 1) return [{ size: length, label: `Linearized at ${sorted[0][1]} (${sorted[0][0].toLocaleString('en-US')})` }];
  return sorted.map(([at, enzyme], i) => {
    const [nextAt, nextEnzyme] = sorted[(i + 1) % sorted.length];
    const size = (nextAt - at + length) % length || length;
    return { size, label: `${enzyme} (${at.toLocaleString('en-US')}) – ${nextEnzyme} (${nextAt.toLocaleString('en-US')})` };
  });
}

const PBR322 = 4361;
const PUC19 = 2686;

const pbrHinfI = (): Fragment[] => {
  // the classic pBR322 / HinfI marker fragments, in map order
  const sizes = [1631, 517, 506, 396, 344, 298, 221, 220, 154, 75];
  const order = [0, 6, 3, 9, 1, 4, 7, 2, 8, 5];
  let at = 3360;
  const cuts: Array<[number, string]> = [];
  for (const k of order) {
    cuts.push([at % PBR322, 'HinfI']);
    at += sizes[k];
  }
  return circularDigest(PBR322, cuts);
};

const DIGEST_LANES: GelLane[] = [
  ladder('ladder', '1 kb Plus', ONE_KB_PLUS),
  sample('ecori', 'EcoRI', circularDigest(PBR322, [[4359, 'EcoRI']])),
  sample('ecori-pvuii', 'EcoRI + PvuII', circularDigest(PBR322, [[4359, 'EcoRI'], [2066, 'PvuII']])),
  sample('hinfi', 'HinfI', pbrHinfI()),
];

const LAMBDA_HINDIII = [23130, 9416, 6557, 4361, 2322, 2027, 564, 125];
const LAMBDA_ECORI = [21226, 7421, 5804, 5643, 4878, 3530];

const TWELVE_LANES: GelLane[] = [
  ladder('l1', '1 kb Plus', ONE_KB_PLUS),
  sample('uncut', 'pUC19 uncut', [
    { size: PUC19, form: 'supercoiled', label: 'Supercoiled' },
    { size: PUC19, form: 'nicked', amount: 0.25, label: 'Open circular (nicked)' },
  ]),
  sample('puc-ecori', 'pUC19 · EcoRI', circularDigest(PUC19, [[396, 'EcoRI']])),
  sample('puc-pvuii', 'pUC19 · PvuII', circularDigest(PUC19, [[306, 'PvuII'], [628, 'PvuII']])),
  sample('puc-eh', 'pUC19 · EcoRI + HindIII', circularDigest(PUC19, [[396, 'EcoRI'], [447, 'HindIII']])),
  sample('pbr-be', 'pBR322 · BamHI + EcoRI', circularDigest(PBR322, [[4359, 'EcoRI'], [375, 'BamHI']])),
  sample('pbr-hinfi', 'pBR322 · HinfI', pbrHinfI()),
  sample('lambda-h', 'λ DNA · HindIII', LAMBDA_HINDIII.map((size) => ({ size }))),
  sample('lambda-e', 'λ DNA · EcoRI', LAMBDA_ECORI.map((size) => ({ size }))),
  sample('pcr1', 'Colony PCR #1', [{ size: 1250, label: 'Insert amplicon' }, { size: 52, amount: 4, label: 'Primer dimer' }]),
  sample('pcr2', 'Colony PCR #2', [{ size: 52, amount: 5, label: 'Primer dimer' }]),
  ladder('l2', '100 bp', HUNDRED_BP),
];

// λ DNA / BstEII: 14 fragments from 8.5 kb to 117 bp (a classic marker).
const LAMBDA_BSTEII = [8454, 7242, 6369, 5686, 4822, 4324, 3675, 2323, 1929, 1371, 1264, 702, 224, 117];

// pBR322 MspI fragments: a classic dense small-fragment marker.
const MSPI = [622, 527, 404, 307, 242, 238, 217, 201, 190, 180, 160, 160, 147, 147, 123, 110, 90, 76, 67, 34, 34, 26, 26, 15, 9];

// ---------------------------------------------------------------------------------------------
// A synthetic 4.6 Mb genome digested by cutters of different frequency (performance / smears)
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random cut sites (exponential spacing) on a circular genome: fragment sizes. */
function genomeFragments(genome: number, meanFragment: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const sizes: number[] = [];
  let total = 0;
  while (total < genome) {
    const s = Math.max(1, Math.round(-Math.log(1 - rnd()) * meanFragment));
    sizes.push(Math.min(s, genome - total));
    total += s;
  }
  return sizes;
}

/** Every fragment as its own band (no merging): thousands of bands per lane. */
function rawLane(id: string, label: string, sizes: readonly number[], agarose = 1): GelLane {
  const pos = migration(agarose);
  const max = Math.max(...sizes);
  return {
    id,
    label,
    kind: 'sample',
    bands: sizes.map((size, i) => ({ size, position: pos(size), intensity: size / max, labels: [`Fragment ${i + 1}`] })),
  };
}

const GENOME = 4_641_652;

function genomeLanes(): GelLane[] {
  return [
    ladder('gl', '1 kb Plus', ONE_KB_PLUS),
    sample('uncut-g', 'Genomic, uncut', [{ size: GENOME, label: 'Chromosome' }]),
    rawLane('noti', 'NotI', genomeFragments(GENOME, 210_000, 7)),
    rawLane('ecori-g', 'EcoRI', genomeFragments(GENOME, 7_200, 11)),
    rawLane('sau3ai', 'Sau3AI', genomeFragments(GENOME, 256, 3)),
  ];
}

// ---------------------------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------------------------

function Frame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--hh-bg-content)' }}>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      {footer}
    </div>
  );
}

function Interactive({
  lanes,
  agarosePercent = 1,
  showSizes,
  initialSelection = null,
  status = false,
}: {
  lanes: readonly GelLane[];
  agarosePercent?: number;
  showSizes?: GelSizeLabels;
  initialSelection?: string | null;
  status?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(initialSelection);
  const [hover, setHover] = useState<{ laneId: string; band: GelLaneBand } | null>(null);
  const footer = status ? (
    <div
      style={{
        height: 'var(--hh-statusbar-height)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--hh-space-3)',
        padding: '0 var(--hh-space-3)',
        borderTop: '1px solid var(--hh-separator)',
        background: 'var(--hh-bg-window)',
        color: 'var(--hh-text-secondary)',
        fontSize: 'var(--hh-text-sm)',
      }}
    >
      <span>Selected lane: {lanes.find((l) => l.id === selected)?.label ?? 'none'}</span>
      <span>
        Hover:{' '}
        {hover ? `${lanes.find((l) => l.id === hover.laneId)?.label} · ${formatGelSize(hover.band.size, 'exact')}${(hover.band.count ?? 1) > 1 ? ` (${hover.band.count} fragments)` : ''}` : '–'}
      </span>
    </div>
  ) : undefined;
  return (
    <Frame footer={footer}>
      <GelView
        lanes={lanes}
        agarosePercent={agarosePercent}
        showSizes={showSizes}
        selectedLaneId={selected}
        onLaneClick={(id) => setSelected((s) => (s === id ? null : id))}
        onBandHover={(laneId, band) => setHover(band ? { laneId, band } : null)}
      />
    </Frame>
  );
}

function GenomeStory() {
  const lanes = useMemo(genomeLanes, []);
  return <Interactive lanes={lanes} status />;
}

function ThumbnailStory() {
  const genome = useMemo(genomeLanes, []);
  const items: Array<{ title: string; lanes: readonly GelLane[] }> = [
    { title: 'pBR322 digests', lanes: DIGEST_LANES },
    { title: 'Plasmid screen', lanes: TWELVE_LANES },
    { title: 'GAPDH PCR', lanes: [sample('pcr', 'PCR', [{ size: 1024 }, { size: 48, amount: 3 }])] },
    { title: 'Genomic digests', lanes: genome },
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--hh-space-6)', padding: 'var(--hh-space-6)' }}>
      {items.map((it) => (
        <figure key={it.title} style={{ margin: 0, display: 'grid', gap: 'var(--hh-space-2)', justifyItems: 'start' }}>
          <GelThumbnail lanes={it.lanes} />
          <figcaption style={{ fontSize: 'var(--hh-text-sm)', color: 'var(--hh-text-secondary)' }}>{it.title}</figcaption>
        </figure>
      ))}
      <figure style={{ margin: 0, display: 'grid', gap: 'var(--hh-space-2)', justifyItems: 'start' }}>
        <GelThumbnail lanes={DIGEST_LANES} width={96} height={120} />
        <figcaption style={{ fontSize: 'var(--hh-text-sm)', color: 'var(--hh-text-secondary)' }}>96 × 120</figcaption>
      </figure>
    </div>
  );
}

export default {
  digest: () => <Interactive lanes={DIGEST_LANES} initialSelection="ecori-pvuii" />,
  'digest-sizes': () => <Interactive lanes={DIGEST_LANES} showSizes="all" />,
  interactive: () => <Interactive lanes={DIGEST_LANES} showSizes="all" status />,
  'single-lane': () => (
    <Interactive lanes={[sample('pcr', 'PCR · GAPDH (1,024 bp)', [{ size: 1024, label: 'GAPDH amplicon' }, { size: 48, amount: 3, label: 'Primer dimer' }])]} />
  ),
  'twelve-lanes': () => <Interactive lanes={TWELVE_LANES} initialSelection="pbr-hinfi" />,
  'twelve-lanes-sizes': () => <Interactive lanes={TWELVE_LANES} showSizes="all" />,
  'dense-ladder': () => (
    <Interactive
      lanes={[
        ladder('mix', 'DNA Ladder Mix', LADDER_MIX),
        sample('bsteii', 'λ DNA · BstEII', LAMBDA_BSTEII.map((size) => ({ size }))),
        ladder('mix-2', 'DNA Ladder Mix', LADDER_MIX),
      ]}
      showSizes="all"
    />
  ),
  'dense-ladder-2pct': () => (
    <Interactive
      agarosePercent={2}
      lanes={[ladder('mix', 'DNA Ladder Mix', LADDER_MIX, 2), sample('mspi', 'pBR322 · MspI', MSPI.map((size) => ({ size })), 2)]}
    />
  ),
  'empty-lane': () => (
    <Interactive
      lanes={[
        ladder('ladder', '1 kb Plus', ONE_KB_PLUS),
        { id: 'empty', label: 'No template', kind: 'sample', bands: [] },
        sample('ecori', 'EcoRI', circularDigest(PBR322, [[4359, 'EcoRI']])),
      ]}
    />
  ),
  'no-lanes': () => <Interactive lanes={[]} />,
  'genome-smear': () => <GenomeStory />,
  thumbnail: () => <ThumbnailStory />,
} satisfies Record<string, () => ReactNode>;
