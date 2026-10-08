/** TEMPORARY review stories (visual reviewer); delete after the review. */
import type { ReactNode } from 'react';
import { GelView } from '../../../../packages/viewer/src/gel';
import type { GelLane } from '../../../../packages/viewer/src/gel';

/** Semi-log position: 0 at 50 kb, 1 at ~40 bp (1 % gel, rough). */
const pos = (size: number) => 1 - (Math.log10(size) - 1.6) / (Math.log10(50000) - 1.6);

const ladder = (id: string, label: string, sizes: number[], emph: number[] = []): GelLane => ({
  id,
  label,
  kind: 'ladder',
  bands: sizes.map((s) => ({ size: s, position: pos(s), intensity: 0.5, emphasized: emph.includes(s) })),
});
const sample = (id: string, label: string, sizes: number[], intensity = 1): GelLane => ({
  id,
  label,
  kind: 'sample',
  bands: sizes.map((s) => ({ size: s, position: pos(s), intensity, labels: [`${s} bp fragment`] })),
});

const LAMBDA_HINDIII = [23130, 9416, 6557, 4361, 2322, 2027, 564, 125];

const CAPTION: GelLane[] = [
  ladder('l', '1 kb', [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500], [3000]),
  sample('a', 'PCR A', [800]),
  sample('b', 'PCR B', [650]),
  {
    id: 'c',
    label: 'Primer dimers',
    kind: 'sample',
    bands: [
      { size: 60, position: 0.95, intensity: 0.8 },
      { size: 45, position: 0.99, intensity: 1 },
      { size: 38, position: 1.02, intensity: 0.9 },
      { size: 30, position: 1.04, intensity: 0.7 },
    ],
  },
];

const LAMBDA_LADDER: GelLane[] = [
  ladder('lh', 'λ / HindIII', LAMBDA_HINDIII),
  sample('x', 'Clone 1 · EcoRI', [6900, 2050]),
  sample('y', 'Clone 2 · EcoRI', [4400, 2030]),
];

const WELL: GelLane[] = [
  ladder('l', '1 kb', [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500], [3000]),
  {
    id: 'w',
    label: 'Stuck in well',
    kind: 'sample',
    bands: [
      { size: 48502, position: -0.05, intensity: 1, labels: ['Genomic DNA (in the well)'] },
      { size: 3000, position: pos(3000), intensity: 0.3 },
    ],
  },
  {
    id: 'faint',
    label: 'Faint',
    kind: 'sample',
    bands: [0.02, 0.05, 0.1, 0.2, 0.4, 0.7, 1].map((intensity, i) => ({
      size: [6000, 4000, 2500, 1500, 1000, 700, 400][i],
      position: pos([6000, 4000, 2500, 1500, 1000, 700, 400][i]),
      intensity,
    })),
  },
  sample('ro', 'Ran off', [300, 25, 12]),
];

const NOSPACE: GelLane[] = [
  ladder('l', 'GeneRuler_1kb_Plus', [10000, 5000, 3000, 2000, 1000, 500]),
  sample('a', 'pUC19_mCherry_clone12_EcoRI_HindIII', [2660, 711]),
  sample('b', 'pUC19_mCherry_clone13_EcoRI_HindIII', [2660, 711]),
];

const frame = (child: ReactNode) => <div style={{ height: '100%', background: 'var(--hh-bg-content)' }}>{child}</div>;

export default {
  caption: () => frame(<GelView lanes={CAPTION} agarosePercent={2} selectedLaneId="c" onLaneClick={() => undefined} />),
  'caption-sizes': () => frame(<GelView lanes={CAPTION} agarosePercent={2} showSizes="all" />),
  'lambda-ladder': () => frame(<GelView lanes={LAMBDA_LADDER} agarosePercent={0.8} showSizes="all" />),
  well: () => frame(<GelView lanes={WELL} agarosePercent={1} showSizes="all" />),
  nospace: () => frame(<GelView lanes={NOSPACE} agarosePercent={1} />),
} satisfies Record<string, () => ReactNode>;
