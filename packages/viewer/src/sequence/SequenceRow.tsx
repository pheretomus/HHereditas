/**
 * Drawing of one row of the sequence view. `RowContent` (bases, numbers, enzymes, primers,
 * features, translations, ORFs) is memoized per row; `RowBackdrop` (selection, search hits,
 * hover bands) and the caret are cheap and re-render with the selection.
 */
import type { EnzymeSite, FragmentEnds, Orf, Topology } from '@hhereditas/core';
import { complement, formatRange, iupacMatches, mod } from '@hhereditas/core';
import { memo, type ReactNode } from 'react';
import { FEATURE_LABEL_ON_FILL } from '../common/colors';
import { formatBp, formatInt } from '../common/format';
import type { BarPiece, LayoutFeature, LayoutPrimer, RowLayout, RowModel } from './layout';
import { colCenter, colLeft, colRight, gapX } from './layout';
import type { CodingInfo } from './translation';
import { rowCodons } from './translation';
import styles from './SequenceView.module.css';

/** Everything a row needs besides its layout; memoized by the view. */
export interface RowRenderContext {
  readonly model: RowModel;
  readonly seq: string;
  readonly topology: Topology;
  readonly features: readonly LayoutFeature[];
  readonly featureFills: readonly string[];
  readonly featureStrokes: readonly string[];
  readonly enzymes: readonly EnzymeSite[];
  readonly primers: readonly LayoutPrimer[];
  /** Annealed part (5'->3') of each primer's sequence, '' when unknown. */
  readonly primerAnnealed: readonly string[];
  readonly orfs: readonly Orf[];
  readonly ends: FragmentEnds | undefined;
  readonly showNumbers: boolean;
  readonly coding: (featureIndex: number) => CodingInfo | null;
  /** x positions (glyph centres) of the bases of a row of n bases, as an SVG list. */
  readonly glyphXs: (n: number) => string;
}

const NBSP = ' ';

/** Baseline that vertically centres capital letters of `size` px in a box [top, top + height). */
function baseline(top: number, height: number, size: number): number {
  return top + height / 2 + size * 0.36;
}

/** Outline of a feature bar piece: rounded closed ends, square open ends, pointed arrow ends. */
export function barPath(x0: number, x1: number, y: number, h: number, piece: BarPiece, arrow: number): string {
  const w = Math.max(0.5, x1 - x0);
  const r = Math.min(3, w / 2, h / 2);
  const a = Math.min(arrow, w * 0.75);
  const mid = y + h / 2;
  const yb = y + h;
  const left = piece.arrowStart ? 'arrow' : piece.openStart ? 'open' : 'round';
  const right = piece.arrowEnd ? 'arrow' : piece.openEnd ? 'open' : 'round';
  const f = (n: number) => Math.round(n * 100) / 100;
  let d = left === 'round' ? `M${f(x0 + r)},${f(y)}` : left === 'arrow' ? `M${f(x0 + a)},${f(y)}` : `M${f(x0)},${f(y)}`;
  if (right === 'round') d += `H${f(x1 - r)}Q${f(x1)},${f(y)} ${f(x1)},${f(y + r)}V${f(yb - r)}Q${f(x1)},${f(yb)} ${f(x1 - r)},${f(yb)}`;
  else if (right === 'arrow') d += `H${f(x1 - a)}L${f(x1)},${f(mid)}L${f(x1 - a)},${f(yb)}`;
  else d += `H${f(x1)}V${f(yb)}`;
  if (left === 'round') d += `H${f(x0 + r)}Q${f(x0)},${f(yb)} ${f(x0)},${f(yb - r)}V${f(y + r)}Q${f(x0)},${f(y)} ${f(x0 + r)},${f(y)}Z`;
  else if (left === 'arrow') d += `H${f(x0 + a)}L${f(x0)},${f(mid)}Z`;
  else d += `H${f(x0)}Z`;
  return d;
}

/** Primer outline: round 5' end (unless cut), pointed 3' tip beyond the last base. */
function primerPath(x0: number, x1: number, y: number, h: number, strand: 1 | -1, tip: boolean, openStart: boolean, openEnd: boolean, tipLength: number): string {
  const r = Math.min(4, h / 2);
  const mid = y + h / 2;
  const yb = y + h;
  const f = (n: number) => Math.round(n * 100) / 100;
  const leftKind = strand === -1 && tip ? 'tip' : openStart ? 'open' : 'round';
  const rightKind = strand === 1 && tip ? 'tip' : openEnd ? 'open' : 'round';
  let d = leftKind === 'round' ? `M${f(x0 + r)},${f(y)}` : `M${f(x0)},${f(y)}`;
  if (rightKind === 'tip') d += `H${f(x1)}L${f(x1 + tipLength)},${f(mid)}L${f(x1)},${f(yb)}`;
  else if (rightKind === 'round') d += `H${f(x1 - r)}Q${f(x1)},${f(y)} ${f(x1)},${f(y + r)}V${f(yb - r)}Q${f(x1)},${f(yb)} ${f(x1 - r)},${f(yb)}`;
  else d += `H${f(x1)}V${f(yb)}`;
  if (leftKind === 'tip') d += `H${f(x0)}L${f(x0 - tipLength)},${f(mid)}Z`;
  else if (leftKind === 'round') d += `H${f(x0 + r)}Q${f(x0)},${f(yb)} ${f(x0)},${f(yb - r)}V${f(y + r)}Q${f(x0)},${f(y)} ${f(x0 + r)},${f(y)}Z`;
  else d += `H${f(x0)}Z`;
  return d;
}

/** Replace the bases of [from, to) (sequence coordinates) inside a row's text by spaces. */
function blank(text: string, rowStart: number, from: number, to: number): string {
  const a = Math.max(from, rowStart) - rowStart;
  const b = Math.min(to, rowStart + text.length) - rowStart;
  if (b <= a) return text;
  return text.slice(0, a) + NBSP.repeat(b - a) + text.slice(b);
}

function featureTitle(f: LayoutFeature['feature'], length: number): string {
  let bases = 0;
  for (const s of f.segments) bases += s.end - s.start;
  const where =
    f.segments.length > 1
      ? `join(${f.segments.map((s) => formatRange(s, length)).join(', ')})`
      : formatRange(f.segments[0] ?? { start: 0, end: 0 }, length);
  const dir = f.strand === 1 ? ' →' : f.strand === -1 ? ' ←' : '';
  return `${f.name}${dir}\n${f.type} · ${where} · ${formatBp(bases)}`;
}

interface RowContentProps {
  row: RowLayout;
  ctx: RowRenderContext;
  /** Index of the highlighted feature when it is in this row, else -1. */
  highlighted: number;
  /** Index of the hovered enzyme site when its label is in this row, else -1. */
  hoveredSite: number;
}

export const RowContent = memo(function RowContent({ row, ctx, highlighted, hoveredSite }: RowContentProps) {
  const { model, seq } = ctx;
  const geo = model.geometry;
  const m = model.metrics;
  const L = model.length;
  const n = row.end - row.start;
  const y = row.y;
  const fs = m.baseFontSize;
  const strandBase = baseline(y.strand, m.strandHeight, fs);
  const complementBase = baseline(y.complement, m.strandHeight, fs);
  const xs = ctx.glyphXs(n);

  // ---- strands ----------------------------------------------------------------------------
  let top = seq.slice(row.start, row.end);
  let bottom = model.showComplement ? complement(top) : '';
  const ends = ctx.topology === 'linear' ? ctx.ends : undefined;
  if (ends) {
    if (ends.left.length > 0) {
      if (ends.left.kind === '5prime') bottom = blank(bottom, row.start, 0, ends.left.length);
      else if (ends.left.kind === '3prime') top = blank(top, row.start, 0, ends.left.length);
    }
    if (ends.right.length > 0) {
      if (ends.right.kind === '5prime') top = blank(top, row.start, L - ends.right.length, L);
      else if (ends.right.kind === '3prime') bottom = blank(bottom, row.start, L - ends.right.length, L);
    }
  }

  const items: ReactNode[] = [];

  // ---- enzyme labels and leaders ------------------------------------------------------------
  const strandBottom = model.showComplement ? y.complement + m.strandHeight : y.strand + m.strandHeight;
  for (const label of row.enzymeLabels) {
    const laneTop = y.enzymes + (row.enzymeLanes - 1 - label.lane) * m.enzymeLaneHeight;
    const site = ctx.enzymes[label.site];
    const hovered = label.site === hoveredSite;
    const lx = Math.round(label.anchorX) + 0.5;
    items.push(
      <g key={`e${label.site}`} className={hovered ? `${styles.enzyme} ${styles.enzymeHover}` : styles.enzyme}>
        <path className={styles.leader} d={`M${lx},${laneTop + m.enzymeLaneHeight - 2.5}V${y.strand}`} />
        <rect
          className={styles.hitArea}
          data-kind="enzyme"
          data-index={label.site}
          x={label.x - 2}
          y={laneTop}
          width={label.width + 4}
          height={m.enzymeLaneHeight}
        >
          <title>{`${site.enzyme}${site.cuts.length ? '' : ' (does not cut)'} · site ${formatRange(site.range, L)}`}</title>
        </rect>
        <text
          className={label.unique ? styles.enzymeLabelUnique : styles.enzymeLabel}
          x={label.x}
          y={laneTop + m.enzymeLaneHeight - 3.5}
          data-kind="enzyme"
          data-index={label.site}
        >
          {label.text}
        </text>
      </g>,
    );
  }

  // ---- primers ------------------------------------------------------------------------------
  for (const p of row.primers) {
    const primer = ctx.primers[p.primer];
    const site = primer.site;
    const fwd = p.strand === 1;
    const laneTop = fwd
      ? y.primersFwd + (row.primerLanesFwd - 1 - p.lane) * m.primerLaneHeight
      : y.primersRev + p.lane * m.primerLaneHeight;
    const pillTop = laneTop + 2;
    const pillH = m.primerLaneHeight - 4;
    const x0 = colLeft(geo, p.startCol) - 0.5;
    const x1 = colRight(geo, p.endCol - 1) + 0.5;
    const annealed = ctx.primerAnnealed[p.primer];
    const len = site.range.end - site.range.start;
    const chars: string[] = [];
    const glyphX: number[] = [];
    const mismatchCols: number[] = [];
    for (let col = p.startCol; col < p.endCol; col++) {
      const pos = row.start + col;
      const o = ctx.topology === 'circular' ? mod(pos - site.range.start, L) : pos - site.range.start;
      const k = fwd ? o : len - 1 - o;
      const base = annealed.length === len ? annealed[k] : '';
      if (!base) continue;
      const templ = fwd ? seq[pos] : complement(seq[pos]);
      if (!(iupacMatches(base, templ) || iupacMatches(templ, base))) mismatchCols.push(col);
      chars.push(base);
      glyphX.push(colCenter(geo, col));
    }
    const tailFlag =
      p.fivePrime && site.tailLength > 0
        ? fwd
          ? `M${x0 + 1},${pillTop}l-4,-4`
          : `M${x1 - 1},${pillTop + pillH}l4,4`
        : null;
    const title = `${primer.name}${fwd ? ' →' : ' ←'}\nbinds ${formatRange(site.range, L)} · ${site.annealedLength} nt${
      site.mismatches ? ` · ${site.mismatches} mismatch${site.mismatches > 1 ? 'es' : ''}` : ''
    }${site.tailLength ? ` · ${site.tailLength} nt 5′ tail` : ''}${site.tm !== undefined ? ` · Tm ${site.tm.toFixed(1)} °C` : ''}`;
    items.push(
      <g key={`p${p.primer}-${p.startCol}`} className={fwd ? styles.primerFwd : styles.primerRev}>
        <path
          className={`${styles.primerBody} ${styles.hit}`}
          data-kind="primer"
          data-index={p.primer}
          d={primerPath(x0, x1, pillTop, pillH, p.strand, p.tip, p.openStart, p.openEnd, m.primerTip)}
        >
          <title>{title}</title>
        </path>
        {mismatchCols.map((col) => (
          <rect
            key={col}
            className={styles.primerMismatchCell}
            x={colLeft(geo, col)}
            y={pillTop + 1}
            width={geo.charWidth}
            height={pillH - 2}
            rx={1.5}
          />
        ))}
        {chars.length > 0 && (
          <text className={styles.primerBases} x={glyphX.join(' ')} y={baseline(pillTop, pillH, m.baseFontSize)}>
            {chars.join('')}
          </text>
        )}
        {mismatchCols.length > 0 && (
          <text
            className={`${styles.primerBases} ${styles.primerMismatch}`}
            x={mismatchCols.map((c) => colCenter(geo, c)).join(' ')}
            y={baseline(pillTop, pillH, m.baseFontSize)}
          >
            {mismatchCols
              .map((col) => {
                const pos = row.start + col;
                const o = ctx.topology === 'circular' ? mod(pos - site.range.start, L) : pos - site.range.start;
                return annealed[fwd ? o : len - 1 - o];
              })
              .join('')}
          </text>
        )}
        {tailFlag && <path className={styles.primerTail} d={tailFlag} />}
        {p.label && (
          <text
            className={`${styles.primerLabel} ${styles.hit}`}
            data-kind="primer"
            data-index={p.primer}
            x={p.label.x}
            y={baseline(pillTop, pillH, 11)}
          >
            {p.label.text}
          </text>
        )}
      </g>,
    );
  }

  // ---- features ------------------------------------------------------------------------------
  const featureItems: ReactNode[] = [];
  for (const piece of row.features) {
    const lf = ctx.features[piece.feature];
    const f = lf.feature;
    const lane = row.featureLanes[piece.lane];
    const barTop = lane.top;
    const fill = ctx.featureFills[piece.feature];
    const stroke = ctx.featureStrokes[piece.feature];
    const isHighlighted = piece.feature === highlighted;
    const children: ReactNode[] = [];
    // thin line through the introns of a joined feature
    if (piece.bars.length !== 1 || piece.bars[0].startCol !== piece.startCol || piece.bars[0].endCol !== piece.endCol) {
      children.push(
        <line
          key="join"
          className={styles.featureJoin}
          style={{ stroke }}
          x1={colLeft(geo, piece.startCol)}
          x2={colRight(geo, piece.endCol - 1)}
          y1={barTop + m.featureBarHeight / 2}
          y2={barTop + m.featureBarHeight / 2}
        />,
      );
    }
    for (const bar of piece.bars) {
      children.push(
        <path
          key={`b${bar.startCol}`}
          className={isHighlighted ? `${styles.featureBar} ${styles.featureBarHighlight}` : styles.featureBar}
          style={{ fill, stroke: isHighlighted ? 'var(--hh-accent)' : stroke }}
          d={barPath(colLeft(geo, bar.startCol), colRight(geo, bar.endCol - 1), barTop, m.featureBarHeight, bar, m.featureArrow)}
          data-kind="feature"
          data-index={piece.feature}
        >
          <title>{featureTitle(f, L)}</title>
        </path>,
      );
    }
    if (piece.label) {
      children.push(
        <text
          key="label"
          className={piece.label.inside ? styles.featureLabel : styles.featureLabelOutside}
          style={piece.label.inside ? { fill: FEATURE_LABEL_ON_FILL } : undefined}
          x={piece.label.x}
          y={baseline(barTop, m.featureBarHeight, 11)}
          data-kind="feature"
          data-index={piece.feature}
        >
          {piece.label.text}
        </text>,
      );
    }
    if (piece.translated && lane.translation) {
      const info = ctx.coding(piece.feature);
      if (info && info.codonCount > 0) {
        const { shades, letters } = rowCodons(info, row.start, piece.bars);
        const trTop = barTop + m.featureBarHeight + 1;
        const trH = m.translationHeight - 2;
        const normal: string[] = [];
        const normalX: number[] = [];
        const stops: string[] = [];
        const stopX: number[] = [];
        for (const l of letters) {
          if (l.aa === '*') {
            stops.push('*');
            stopX.push(colCenter(geo, l.col));
          } else if (l.aa) {
            normal.push(l.aa);
            normalX.push(colCenter(geo, l.col));
          }
        }
        children.push(
          <g key="tr" className={styles.translation}>
            {shades.map((s) => (
              <rect
                key={`${s.codon}-${s.c0}`}
                className={s.codon % 2 === 0 ? styles.codonEven : styles.codonOdd}
                style={{ fill }}
                x={colLeft(geo, s.c0) + 0.5}
                y={trTop}
                width={Math.max(0.5, colRight(geo, s.c1 - 1) - colLeft(geo, s.c0) - 1)}
                height={trH}
                rx={2}
              />
            ))}
            {normal.length > 0 && (
              <text className={styles.aminoAcids} x={normalX.join(' ')} y={baseline(trTop, trH, 11)}>
                {normal.join('')}
              </text>
            )}
            {stops.length > 0 && (
              <text className={`${styles.aminoAcids} ${styles.stop}`} x={stopX.join(' ')} y={baseline(trTop, trH, 11)}>
                {stops.join('')}
              </text>
            )}
            <rect
              className={styles.hitArea}
              data-kind="translation"
              data-index={piece.feature}
              x={colLeft(geo, piece.startCol)}
              y={trTop}
              width={colRight(geo, piece.endCol - 1) - colLeft(geo, piece.startCol)}
              height={trH}
            />
          </g>,
        );
      }
    }
    featureItems.push(
      <g key={`f${piece.feature}-${piece.startCol}`} className={styles.feature}>
        {children}
      </g>,
    );
  }

  // ---- ORFs ---------------------------------------------------------------------------------
  const orfItems: ReactNode[] = [];
  for (const p of row.orfs) {
    const orf = ctx.orfs[p.orf];
    const mid = y.orfs + p.lane * m.orfLaneHeight + m.orfLaneHeight / 2;
    const x0 = colLeft(geo, p.startCol);
    const x1 = colRight(geo, p.endCol - 1);
    const h = 1.5;
    let d: string;
    if (p.tip && orf.strand === 1) d = `M${x0},${mid - h}H${x1 - 1}L${x1 + 4},${mid}L${x1 - 1},${mid + h}H${x0}Z`;
    else if (p.tip && orf.strand === -1) d = `M${x1},${mid - h}H${x0 + 1}L${x0 - 4},${mid}L${x0 + 1},${mid + h}H${x1}Z`;
    else d = `M${x0},${mid - h}H${x1}V${mid + h}H${x0}Z`;
    if (p.tip) {
      // arrow head
      d += orf.strand === 1 ? `M${x1 - 2},${mid - 3.5}L${x1 + 4},${mid}L${x1 - 2},${mid + 3.5}Z` : `M${x0 + 2},${mid - 3.5}L${x0 - 4},${mid}L${x0 + 2},${mid + 3.5}Z`;
    }
    orfItems.push(
      <path key={`o${p.orf}-${p.startCol}`} className={`${styles.orf} ${styles.hit}`} d={d} data-kind="orf" data-index={p.orf}>
        <title>{`ORF ${orf.strand === 1 ? '→' : '←'} frame ${orf.strand === 1 ? '+' : '−'}${orf.frame + 1} · ${formatRange(orf.range, L)} · ${formatInt(orf.aaLength)} aa`}</title>
      </path>,
    );
  }

  // ---- cut marks (drawn over the bases) --------------------------------------------------------
  let cuts = '';
  for (const c of row.cutMarks) {
    const yMid = model.showComplement ? y.complement : y.strand + m.strandHeight;
    const r = (v: number) => Math.round(v) + 0.5;
    if (c.top !== null) cuts += `M${r(gapX(geo, c.top, n))},${y.strand + 1}V${yMid}`;
    if (c.to > c.from) cuts += `M${r(gapX(geo, c.from, n))},${yMid}H${r(gapX(geo, c.to, n))}`;
    if (c.bottom !== null) cuts += `M${r(gapX(geo, c.bottom, n))},${yMid}V${model.showComplement ? strandBottom - 1 : yMid + 4}`;
  }

  const number = ctx.showNumbers && n > 0 ? formatInt(row.start + 1) : null;

  return (
    <svg className={styles.rowContent} width={geo.width} height={row.height} aria-hidden="true">
      {number && (
        <text className={styles.number} x={geo.textLeft - m.numberGap} y={strandBase}>
          {number}
        </text>
      )}
      {items}
      {n > 0 && (
        <text className={styles.bases} x={xs} y={strandBase}>
          {top}
        </text>
      )}
      {n > 0 && model.showComplement && (
        <text className={`${styles.bases} ${styles.complement}`} x={xs} y={complementBase}>
          {bottom}
        </text>
      )}
      {cuts && <path className={styles.cut} d={cuts} />}
      {featureItems}
      {orfItems}
    </svg>
  );
});

interface RowBackdropProps {
  row: RowLayout;
  model: RowModel;
  /** Selected columns [c0, c1). */
  selection: ReadonlyArray<readonly [number, number]>;
  /** Search hits on the top / bottom strand. */
  hitsTop: ReadonlyArray<readonly [number, number]>;
  hitsBottom: ReadonlyArray<readonly [number, number]>;
  /** Hover / highlight bands over both strands. */
  bands: ReadonlyArray<readonly [number, number]>;
  focused: boolean;
}

/** Selection, search hits and hover bands, drawn under the bases. */
export function RowBackdrop({ row, model, selection, hitsTop, hitsBottom, bands, focused }: RowBackdropProps) {
  if (selection.length === 0 && hitsTop.length === 0 && hitsBottom.length === 0 && bands.length === 0) return null;
  const geo = model.geometry;
  const m = model.metrics;
  const y = row.y;
  const strandsTop = y.strand;
  const strandsBottom = model.showComplement ? y.complement + m.strandHeight : y.strand + m.strandHeight;
  const x0 = (c: number) => colLeft(geo, c);
  const x1 = (c: number) => colRight(geo, c - 1);
  return (
    <svg className={styles.rowBackdrop} width={geo.width} height={row.height} aria-hidden="true">
      {bands.map(([a, b]) => (
        <rect key={`band${a}`} className={styles.band} x={x0(a)} y={strandsTop - 2} width={x1(b) - x0(a)} height={strandsBottom - strandsTop + 4} rx={2} />
      ))}
      {hitsTop.map(([a, b]) => (
        <rect key={`ht${a}`} className={styles.searchHit} x={x0(a)} y={y.strand} width={x1(b) - x0(a)} height={m.strandHeight} rx={2} />
      ))}
      {hitsBottom.map(([a, b]) => (
        <rect
          key={`hb${a}`}
          className={styles.searchHit}
          x={x0(a)}
          y={model.showComplement ? y.complement : y.strand}
          width={x1(b) - x0(a)}
          height={m.strandHeight}
          rx={2}
        />
      ))}
      {selection.map(([a, b]) => (
        <rect
          key={`sel${a}`}
          className={focused ? styles.selection : `${styles.selection} ${styles.selectionInactive}`}
          x={x0(a)}
          y={strandsTop - 1}
          width={x1(b) - x0(a)}
          height={strandsBottom - strandsTop + 2}
        />
      ))}
    </svg>
  );
}
