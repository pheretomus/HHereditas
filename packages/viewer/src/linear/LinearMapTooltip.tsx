/**
 * Hover card for the linear map: what is under the pointer, in three calm lines (name, kind,
 * position), laid out like the circular map's card.
 */
import type { EnzymeSite, Range, SeqRecord, Topology } from '@hhereditas/core';
import { mod, normalizeRange } from '@hhereditas/core';
import type { ReactNode } from 'react';
import { featureFill } from '../common/colors';
import { formatBp, formatInt, formatPosition } from '../common/format';
import { cutDisplayPosition } from './enzymeLabels';
import type { FeatureEntry, OrfEntry, PrimerEntry, TrackSet } from './layout';
import styles from './LinearMap.module.css';
import type { MapTarget } from './types';

/** "1,201..1,500": 1-based and inclusive; a range wrapping the origin reads "3,901..40". */
export function formatSpan(range: Range, seqLength: number, topology: Topology): string {
  const r = normalizeRange(range, seqLength, topology);
  if (r.end <= r.start) return formatPosition(r.start);
  const last = seqLength > 0 ? mod(r.end - 1, seqLength) : r.end - 1;
  return `${formatPosition(r.start)}..${formatPosition(last)}`;
}

function strandText(strand: number): string {
  return strand === 1 ? 'Forward' : strand === -1 ? 'Reverse' : 'No strand';
}

export interface TooltipData {
  record: SeqRecord;
  features: TrackSet<FeatureEntry> | null;
  primers: TrackSet<PrimerEntry> | null;
  orfs: TrackSet<OrfEntry> | null;
  enzymeSites: readonly EnzymeSite[] | undefined;
}

function Title({ children, swatch }: { children: ReactNode; swatch?: string }) {
  return (
    <div className={styles.ttTitle}>
      {swatch ? <span className={styles.ttSwatch} style={{ background: swatch }} /> : null}
      <span className={styles.ttTitleText}>{children}</span>
    </div>
  );
}

/** Content for a hover target, or null when nothing is worth a card. */
export function tooltipContent(target: MapTarget, data: TooltipData): ReactNode {
  const L = data.record.seq.length;
  const topo = data.record.topology;
  switch (target.kind) {
    case 'feature': {
      const entry = data.features?.entries.find((e) => e.feature.id === target.id);
      if (!entry) return null;
      const f = entry.feature;
      const len = entry.segments.reduce((n, s) => n + (s.end - s.start), 0);
      return (
        <>
          <Title swatch={featureFill(f)}>{f.name || f.type}</Title>
          <div className={styles.ttMeta}>
            {f.type} · {strandText(f.strand)}
            {f.segments.length > 1 ? ` · ${f.segments.length} segments` : ''}
          </div>
          <div className={styles.ttRange}>
            {formatSpan(entry.extent, L, topo)} · {formatBp(len)}
          </div>
        </>
      );
    }
    case 'enzyme': {
      const site = target.site;
      const count = (data.enzymeSites ?? []).reduce((n, s) => n + (s.enzyme === site.enzyme ? s.cuts.length : 0), 0);
      const cuts = site.cuts.map((c) => formatInt(cutDisplayPosition(mod(c.top, Math.max(1, L)), L, topo)));
      return (
        <>
          <Title>{site.enzyme}</Title>
          <div className={styles.ttMeta}>
            {count === 1 ? 'Unique cutter' : count === 0 ? 'Does not cut' : `Cuts ${formatInt(count)} times`}
            {cuts.length ? ` · cuts after ${cuts.join(' and ')}` : ''}
          </div>
          <div className={styles.ttRange}>
            Site {formatSpan(site.range, L, topo)} · {site.strand === 1 ? 'top strand' : 'bottom strand'}
          </div>
        </>
      );
    }
    case 'primer': {
      const entry = data.primers?.entries.find((e) => e.site.primerId === target.id);
      if (!entry) return null;
      const s = entry.site;
      return (
        <>
          <Title>{entry.name}</Title>
          <div className={styles.ttMeta}>
            {s.strand === 1 ? 'Forward primer' : 'Reverse primer'}
            {s.tm !== undefined ? ` · Tm ${s.tm.toFixed(1)} °C` : ''}
            {s.mismatches > 0 ? ` · ${s.mismatches} mismatch${s.mismatches === 1 ? '' : 'es'}` : ''}
          </div>
          <div className={styles.ttRange}>
            {formatSpan(entry.annealed, L, topo)} · {formatBp(s.annealedLength)}
            {s.tailLength > 0 ? ` + ${formatInt(s.tailLength)} nt tail` : ''}
          </div>
        </>
      );
    }
    case 'orf': {
      const o = target.orf;
      const r = normalizeRange(o.range, L, topo);
      return (
        <>
          <Title>ORF · {formatInt(o.aaLength)} aa</Title>
          <div className={styles.ttMeta}>
            Frame {o.strand === 1 ? '+' : '−'}
            {o.frame + 1} · {strandText(o.strand)}
            {o.hasStop ? '' : ' · no stop codon'}
          </div>
          <div className={styles.ttRange}>
            {formatSpan(o.range, L, topo)} · {formatBp(r.end - r.start)}
          </div>
        </>
      );
    }
    default:
      return null;
  }
}

/** Stable identity of a target, to tell whether the hover moved to another item. */
export function targetKey(t: MapTarget | null): string {
  if (!t) return '';
  switch (t.kind) {
    case 'feature':
    case 'primer':
      return `${t.kind}:${t.id}`;
    case 'enzyme':
      return `enzyme:${t.site.enzyme}:${t.site.range.start}:${t.site.strand}`;
    case 'orf':
      return `orf:${t.orf.range.start}:${t.orf.range.end}:${t.orf.strand}:${t.orf.frame}`;
    default:
      return t.kind;
  }
}
