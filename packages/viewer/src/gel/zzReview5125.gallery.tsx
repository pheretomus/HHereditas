/**
 * TEMPORARY review stories (port 5125 reviewer). Delete before finishing.
 */
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { GelView } from './GelView';
import { GelThumbnail } from './GelThumbnail';
import type { GelLane, GelLaneBand, GelSizeLabels } from './types';

type LogEntry = { t: number; kind: 'click' | 'hover'; laneId: string; bandIndex?: number | null; size?: number | null; count?: number };

interface ReviewWindow {
  __gelLog: LogEntry[];
  __gelLanes: readonly GelLane[];
  __gelSet?: (next: Partial<{ width: number; height: number; lanes: readonly GelLane[]; sizes: GelSizeLabels }>) => void;
  __gelRendered?: number;
  __gelT0?: number;
  __gelPainted?: number;
}

const w = window as unknown as ReviewWindow;

function pos(size: number): number {
  return 0.178 + 0.722 / (1 + (size / 1494) ** 1.12);
}

function lane(id: string, label: string, kind: 'ladder' | 'sample', sizes: number[], emph: number[] = []): GelLane {
  const max = Math.max(...sizes, 1);
  return {
    id,
    label,
    kind,
    bands: sizes.map((s) => ({
      size: s,
      position: pos(s),
      intensity: kind === 'ladder' ? (emph.includes(s) ? 1 : 0.45) : s / max,
      emphasized: emph.includes(s),
      labels: [`${label} frag ${s}`],
    })),
  };
}

const LADDER = lane('ladder', '1 kb Plus', 'ladder', [20000, 10000, 7000, 5000, 4000, 3000, 2000, 1500, 1000, 700, 500, 400, 300, 200, 75], [5000, 1500, 500]);
const BASE: GelLane[] = [
  LADDER,
  lane('ecori', 'EcoRI', 'sample', [4361]),
  lane('ep', 'EcoRI + PvuII', 'sample', [2293, 2068]),
  lane('hinfi', 'HinfI', 'sample', [1631, 517, 506, 396, 344, 298, 221, 220, 154, 75]),
];

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

function genomeFragments(genome: number, mean: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const sizes: number[] = [];
  let total = 0;
  while (total < genome) {
    const s = Math.max(1, Math.round(-Math.log(1 - rnd()) * mean));
    sizes.push(Math.min(s, genome - total));
    total += s;
  }
  return sizes;
}

function raw(id: string, label: string, sizes: readonly number[]): GelLane {
  const max = Math.max(...sizes);
  return { id, label, kind: 'sample', bands: sizes.map((s, i) => ({ size: s, position: pos(s), intensity: s / max, labels: [`Fragment ${i + 1}`] })) };
}

function genome(): GelLane[] {
  return [LADDER, lane('uncut', 'Genomic, uncut', 'sample', [4_641_652]), raw('noti', 'NotI', genomeFragments(4_641_652, 210_000, 7)), raw('ecori-g', 'EcoRI', genomeFragments(4_641_652, 7200, 11)), raw('sau', 'Sau3AI', genomeFragments(4_641_652, 256, 3))];
}

function many(nLanes: number): GelLane[] {
  const out: GelLane[] = [LADDER];
  for (let i = 1; i < nLanes - 1; i++) out.push(lane(`c${i}`, `Colony ${i}`, 'sample', i % 3 === 0 ? [312, 52] : [1250, 52]));
  out.push(lane('m2', '100 bp', 'ladder', [1517, 1200, 1000, 900, 800, 700, 600, 517, 400, 300, 200, 100], [1000, 517]));
  return out;
}

function params() {
  const q = new URLSearchParams(window.location.search);
  return {
    sizes: (q.get('sizes') as GelSizeLabels | null) ?? 'ladder',
    readonly: q.get('readonly') === '1',
    width: q.get('w') ? Number(q.get('w')) : undefined,
    height: q.get('h') ? Number(q.get('h')) : undefined,
    which: q.get('lanes') ?? 'base',
    agarose: q.get('agarose') ? Number(q.get('agarose')) : 1,
  };
}

function Logged({ initial }: { initial: () => readonly GelLane[] }) {
  const p = params();
  const [lanes, setLanes] = useState<readonly GelLane[]>(() => initial());
  const [size, setSize] = useState<{ width?: number; height?: number }>({ width: p.width, height: p.height });
  const [sizes, setSizes] = useState<GelSizeLabels>(p.sizes);
  const [selected, setSelected] = useState<string | null>(null);
  w.__gelLanes = lanes;
  if (!w.__gelLog) w.__gelLog = [];
  w.__gelSet = (next) => {
    if (next.lanes) setLanes(next.lanes);
    if (next.width !== undefined || next.height !== undefined) setSize((s) => ({ width: next.width ?? s.width, height: next.height ?? s.height }));
    if (next.sizes) setSizes(next.sizes);
  };
  if (w.__gelT0 === undefined) w.__gelT0 = performance.now();
  useLayoutEffect(() => {
    w.__gelRendered = performance.now();
  });
  useEffect(() => {
    let raf = 0;
    const check = () => {
      if (document.querySelector('svg rect') && w.__gelPainted === undefined) {
        requestAnimationFrame(() => {
          w.__gelPainted = performance.now();
        });
        return;
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, []);
  const onBandHover = (laneId: string, band: GelLaneBand | null) => {
    const l = lanes.find((x) => x.id === laneId);
    const idx = band && l ? l.bands.indexOf(band) : null;
    w.__gelLog.push({ t: performance.now(), kind: 'hover', laneId, bandIndex: band ? idx : null, size: band ? band.size : null, count: band?.count });
  };
  const onLaneClick = (laneId: string) => {
    w.__gelLog.push({ t: performance.now(), kind: 'click', laneId });
    setSelected((s) => (s === laneId ? null : laneId));
  };
  const box = size.width !== undefined || size.height !== undefined;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--hh-bg-content)' }}>
      <div style={box ? { width: size.width ?? '100%', height: size.height ?? '100%', border: '1px dashed var(--hh-separator)' } : { flex: 1, minHeight: 0 }}>
        <GelView
          lanes={lanes}
          agarosePercent={p.agarose}
          showSizes={sizes}
          selectedLaneId={selected}
          onLaneClick={p.readonly ? undefined : onLaneClick}
          onBandHover={onBandHover}
        />
      </div>
      <button id="after" style={{ position: 'absolute', right: 4, bottom: 4 }}>after</button>
    </div>
  );
}

function ThumbMany() {
  const lanes = useMemo(() => many(100), []);
  const lanes48 = useMemo(() => many(48), []);
  return (
    <div style={{ display: 'flex', gap: 24, padding: 24 }}>
      <GelThumbnail lanes={lanes48} />
      <GelThumbnail lanes={lanes} />
      <GelThumbnail lanes={[]} />
    </div>
  );
}

export default {
  log: () => <Logged initial={() => BASE} />,
  genome: () => <Logged initial={genome} />,
  many: () => <Logged initial={() => many(Number(new URLSearchParams(window.location.search).get('n') ?? 48))} />,
  empty: () => <Logged initial={() => []} />,
  thumbs: () => <ThumbMany />,
} satisfies Record<string, () => ReactNode>;
