/**
 * Hover card for the linear map: what is under the pointer, in two calm lines.
 */
import type { EnzymeSite, Range, SeqRecord, Topology } from '@hhereditas/core';
import { normalizeRange } from '@hhereditas/core';
import type { ReactNode } from 'react';
import { featureFill } from '../common/colors';
import { formatBp, formatInt } from '../common/format';
import { cutDisplayPosition } from './enzymeLabels';
import type { FeatureEntry, OrfEntry, PrimerEntry, TrackSet } from './layout';
import styles from './LinearMap.module.css';
import type { MapTarget } from './types';

/** "1,201..1,500" (1-based, inclusive; wrapping ranges read "3,901..40"). */
export function formatSpan(range: Range, seqLength: number, topology: Topology): string {
  const r = normalizeRange(range, seqLength, topology);
  const last = r.end > seqLength ? r.end - seqLength : r.end;
  return `${formatInt(r.start + 1)}..${formatInt(last)}`;
}

const STRAND_TEXT = { 1: 'Forward', [-1]: 'Reverse', 0: 'No strand' } as const;

export interface TooltipData {
  record: SeqRecord;
  features: TrackSet<FeatureEntry> | null;
  orfs: TrackSet<OrfEntry> | null;
  primers: TrackSet<PrimerEntry> | null;
  enzymeSites: readonly EnzymeSite[] | undefined;
}

/** Content for a hover target, or null when nothing is worth a tooltip. */
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
          <div className={styles.tooltipTitle}>
            <span className={styles.tooltipSwatch} style={{ background: featureFill(f) }} />
            {f.name || f.type}
          </div>
          <div className={styles.tooltipMeta}>
            {f.type} · {formatSpan(entry.extent, L, topo)} · {formatBp(len)}
            {f.segments.length > 1 ? ` · ${f.segments.length} segments` : ''} · {STRAND_TEXT[f.strand]}
          </div>
        </>
      );
    }
    case 'enzyme': {
      const site = target.site;
      const all = (data.enzymeSites ?? []).filter((s) => s.enzyme === site.enzyme);
      const cutCount = all.reduce((n, s) => n + s.cuts.length, 0);
      const cuts = site.cuts.map((c) => formatInt(cutDisplayPosition(c.top, L, topo)));
      return (
        <>
          <div className={styles.tooltipTitle}>{site.enzyme}</div>
          <div className={styles.tooltipMeta}>
            {cuts.length > 0 ? `Cuts after ${cuts.join(' and ')}` : 'Recognised, not cut'} · site {formatSpan(site.range, L, topo)}
          </div>
          <div className={styles.tooltipMeta}>{cutCount === 1 ? 'Unique cutter' : `${formatInt(cutCount)} cuts in this sequence`}</div>
        </>
      );
    }
    case 'primer': {
      const entry = data.primers?.entries.find((e) => e.site.primerId === target.id);
      if (!entry) return null;
      const s = entry.site;
      const parts = [
        s.strand === 1 ? 'Forward' : 'Reverse',
        `binds ${formatSpan(entry.annealed, L, topo)}`,
        s.tm !== undefined ? `Tm ${s.tm.toFixed(1)} °C` : null,
        s.mismatches > 0 ? `${s.mismatches} mismatch${s.mismatches === 1 ? '' : 'es'}` : null,
        s.tailLength > 0 ? `${s.tailLength} nt 5′ tail` : null,
      ].filter(Boolean);
      return (
        <>
          <div className={styles.tooltipTitle}>{entry.name}</div>
          <div className={styles.tooltipMeta}>{parts.join(' · ')}</div>
        </>
      );
    }
    case 'orf': {
      const o = target.orf;
      const frame = `${o.strand === 1 ? '+' : '−'}${o.frame + 1}`;
      const len = normalizeRange(o.range, L, topo);
      return (
        <>
          <div className={styles.tooltipTitle}>ORF · {formatInt(o.aaLength)} aa</div>
          <div className={styles.tooltipMeta}>
            Frame {frame} · {formatSpan(o.range, L, topo)} · {formatBp(len.end - len.start)}
            {o.hasStop ? '' : ' · no stop codon'}
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
      return `orf:${t.orf.range.start}:${t.orf.range.end}:${t.orf.strand}`;
    default:
      return t.kind;
  }
}
