/**
 * SVG layers of the linear map. Each layer is memoized on the data it draws, so hovering or
 * moving the selection does not re-render the (much larger) map content.
 */
import { memo, useId, type ReactElement } from 'react';
import { featureStroke } from '../common/colors';
import type { SequenceSelection } from '../selection';
import { hasSelectedBases } from '../selection';
import { LABEL_ON_DARK_FILL, hexLuminance } from './labelColor';
import type { EnzymeLabel, ViewModel } from './layout';
import styles from './LinearMap.module.css';
import { caretPositions, selectionPieces } from './selectionGeometry';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Everything that depends only on the view model (data + viewport + size). */
export const MapContent = memo(function MapContent({ view }: { view: ViewModel }) {
  const { v, backbone, letters, ticks, features, orfs, primers, enzymes } = view;
  // Every element carries its identity (data-k) and vertical reference (data-y, or its own y), and each label's
  // leader its label's identity (data-lead): between two layouts of the same window at different sizes, LinearMap
  // glides each from where it was to where it is.
  const strandY = r2(v.topStrandY);
  return (
    <>
      {enzymes.labels.map((l) => (
        <path key={l.key} data-lead={`e:${l.key}`} className={styles.leader} d={l.leader} />
      ))}

      {/* ORFs and primers sit outside the feature lanes */}
      {orfs.small.map((p) => (
        <path key={p.key} data-k={`os:${p.key}`} data-y={r2(p.y)} className={p.dir === 1 ? styles.orfFwd : styles.orfRev} d={p.d} />
      ))}
      {orfs.glyphs.map((g) => (
        <path key={g.key} data-k={`o:${g.key}`} data-y={r2(g.y)} className={g.dir === 1 ? styles.orfFwd : styles.orfRev} d={g.d} />
      ))}
      {primers.glyphs.map((g) => (
        <g key={g.key} data-k={`p:${g.key}`} data-y={r2(g.y)}>
          {g.tail ? <path className={`${styles.primerTail} ${g.dir === 1 ? styles.primerTailFwd : styles.primerTailRev}`} d={g.tail} /> : null}
          {g.d ? <path className={g.dir === 1 ? styles.primerFwd : styles.primerRev} d={g.d} /> : null}
        </g>
      ))}
      {primers.labels.map((l) =>
        l.leader ? (
          <path key={l.key} data-lead={`t:${l.key}`} className={`${styles.primerLeader} ${l.dir === 1 ? styles.primerTailFwd : styles.primerTailRev}`} d={l.leader} />
        ) : null,
      )}

      {/* features: density, slim bars, full glyphs, leaders, labels */}
      {features.density.map((p) => (
        <path key={p.key} data-k={`fd:${p.key}`} data-y={r2(p.y)} d={p.d} style={{ fill: p.fill, opacity: p.opacity, ...lightOutline(p.fill) }} />
      ))}
      {features.small.map((p) => (
        <path key={p.key} data-k={`fs:${p.key}`} data-y={r2(p.y)} d={p.d} style={{ fill: p.fill, ...lightOutline(p.fill) }} />
      ))}
      {features.glyphs.map((g) =>
        g.connector ? <path key={`${g.key}:c`} data-k={`c:${g.key}`} data-y={r2(g.y)} className={styles.connector} d={g.connector} /> : null,
      )}
      {features.labels.some((l) => l.leader) ? (
        <g data-testid="feature-leaders" className={styles.featureLeader}>
          {features.labels.map((l) => (l.leader ? <path key={l.key} data-lead={`t:${l.key}`} d={l.leader} /> : null))}
        </g>
      ) : null}
      {features.glyphs.map((g) => (
        <path key={g.key} data-k={`f:${g.key}`} data-y={r2(g.y)} className={styles.feature} d={g.d} style={{ fill: g.fill, stroke: featureStroke(g.fill) }} />
      ))}
      {/* a half-transparent backing behind the labels: lines passing behind them stay faintly visible */}
      <g className={styles.labelBacking}>
        {[...features.labels.filter((l) => l.placement !== 'inside'), ...primers.labels, ...enzymes.labels].map((l) => (
          <rect key={l.key} data-k={`r:${l.key}`} x={r2(l.left)} y={r2(l.top)} width={r2(l.right - l.left)} height={r2(l.bottom - l.top)} rx={2} />
        ))}
      </g>
      {primers.labels.map((l) => (
        <text
          key={l.key}
          data-k={`t:${l.key}`}
          className={`${styles.primerLabel} ${l.dir === 1 ? styles.primerFwd : styles.primerRev}`}
          x={r2(l.x)}
          y={r2(l.y)}
          textAnchor={l.anchor}
          dominantBaseline="central"
        >
          {l.text}
        </text>
      ))}
      {features.labels.map((l) => (
        <text
          key={l.key}
          data-k={`t:${l.key}`}
          data-label-tier={l.placement}
          className={styles.featureLabel}
          // black, except inside a bar dark enough that white text reads better (see labelColorOnFill)
          style={l.placement === 'inside' && l.onFill === LABEL_ON_DARK_FILL ? { fill: '#ffffff' } : undefined}
          x={r2(l.x)}
          y={r2(l.y)}
          textAnchor={l.anchor}
          dominantBaseline="central"
        >
          {l.text}
        </text>
      ))}

      {/* backbone: two strands (one for RNA and protein), letters at high zoom */}
      {backbone.top ? (
        <path data-k="strand:top" data-y={r2(backbone.topY)} className={styles.strand} d={`M${r2(backbone.top[0])} ${r2(backbone.topY)}H${r2(backbone.top[1])}`} />
      ) : null}
      {backbone.bottom ? (
        <path
          data-k="strand:bottom"
          data-y={r2(backbone.bottomY)}
          className={styles.strand}
          d={`M${r2(backbone.bottom[0])} ${r2(backbone.bottomY)}H${r2(backbone.bottom[1])}`}
        />
      ) : null}
      {backbone.continuation ? <path data-k="strand:continuation" data-y={strandY} className={styles.continuation} d={backbone.continuation} /> : null}
      {letters?.top ? (
        <text
          data-k="letters:top"
          className={styles.letters}
          style={{ fontSize: letters.fontSize }}
          x={letters.top.xs}
          y={r2(letters.topY)}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {letters.top.text}
        </text>
      ) : null}
      {letters?.bottom ? (
        <text
          data-k="letters:bottom"
          className={`${styles.letters} ${styles.lettersComplement}`}
          style={{ fontSize: letters.fontSize }}
          x={letters.bottom.xs}
          y={r2(letters.bottomY)}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {letters.bottom.text}
        </text>
      ) : null}

      {/* ruler */}
      {ticks.minor ? <path data-k="ruler:minor" data-y={r2(v.rulerTop)} className={styles.tickMinor} d={ticks.minor} /> : null}
      {ticks.major ? <path data-k="ruler:major" data-y={r2(v.rulerTop)} className={styles.tickMajor} d={ticks.major} /> : null}
      {ticks.labels.map((t) => (
        <text key={t.key} data-k={`k:${t.key}`} className={styles.tickLabel} x={r2(t.x)} y={r2(t.y)} textAnchor="middle" dominantBaseline="central">
          {t.text}
        </text>
      ))}

      {/* enzyme cuts and labels */}
      {enzymes.ticksUnlabelled ? <path data-k="cuts:quiet" data-y={strandY} className={styles.cutTickQuiet} d={enzymes.ticksUnlabelled} /> : null}
      {enzymes.ticks ? <path data-k="cuts" data-y={strandY} className={styles.cutTick} d={enzymes.ticks} /> : null}
      {enzymes.staggered ? <path data-k="cuts:staggered" data-y={strandY} className={styles.cutStaggered} d={enzymes.staggered} /> : null}
      {enzymes.labels.map((l) => (
        <EnzymeText key={l.key} label={l} />
      ))}
    </>
  );
});

/**
 * The aligned sequences, drawn over the map (their band dims the leaders and labels behind it). Kept apart from
 * MapContent so that sliding them in (`shiftX`, px to the right) redraws only this layer.
 */
export const AlignmentLayer = memo(function AlignmentLayer({ alignments, shiftX = 0 }: { alignments: ViewModel['alignments']; shiftX?: number }) {
  if (!alignments.band && alignments.glyphs.length === 0) return null;
  return (
    <g transform={shiftX ? `translate(${r2(shiftX)} 0)` : undefined}>
      {/* the aligned sequences are on top of everything else: their band dims the leaders and labels behind it */}
      {alignments.band ? (
        <rect
          data-testid="alignment-band"
          className={styles.alignmentBand}
          x={r2(alignments.band.x0)}
          y={r2(alignments.band.y)}
          width={r2(alignments.band.x1 - alignments.band.x0)}
          height={r2(alignments.band.height)}
          rx={2}
        />
      ) : null}
      {alignments.glyphs.map((g) => (
        <g key={g.key} data-testid="alignment-glyph" data-alignment-id={g.id}>
          <path className={styles.alignmentBody} d={g.outline} />
          {g.fill ? <path className={styles.alignmentFill} d={g.fill} /> : null}
          {g.gaps ? <path className={styles.alignmentGap} d={g.gaps} /> : null}
          <path className={styles.alignmentOutline} d={g.outline} />
          {g.inserts ? <path className={styles.alignmentInsert} d={g.inserts} /> : null}
        </g>
      ))}
    </g>
  );
});

function EnzymeText({ label, hot = false }: { label: EnzymeLabel; hot?: boolean }) {
  const cls = [styles.enzymeLabel, label.unique ? styles.enzymeLabelUnique : '', hot ? styles.enzymeHot : ''].filter(Boolean).join(' ');
  return (
    <text data-k={`e:${label.key}`} className={cls} x={r2(label.x)} y={r2(label.y)} textAnchor={label.anchor} dominantBaseline="central">
      {label.text}
    </text>
  );
}

interface SelectionProps {
  view: ViewModel;
  selection: SequenceSelection | null;
}

/** Visible x extents of the selected range (two pieces when a circular selection wraps the origin). */
function selectionExtents(view: ViewModel, selection: SequenceSelection) {
  const { scale, width, seqLength, topology } = view;
  const clampX = (x: number) => Math.min(width + 2, Math.max(-2, x));
  return selectionPieces(selection.range, seqLength, topology).map((p) => {
    const x0 = clampX(scale.x(p.start));
    const x1 = Math.max(x0 + 1, clampX(scale.x(p.end)));
    return { key: `${p.start}-${p.end}`, x0, x1, startEdge: p.startEdge && x0 > -2, endEdge: p.endEdge && x1 < width + 2 };
  });
}

/**
 * A thin outline for the slim bars and density marks of very small features when their fill is (nearly) white: with
 * no border they would vanish against the white map, as white bars do once the window is too narrow for full glyphs.
 */
export function lightOutline(fill: string): { stroke?: string; strokeWidth?: number } {
  const lum = hexLuminance(fill);
  return lum !== null && lum > 0.8 ? { stroke: featureStroke(fill), strokeWidth: 0.75 } : {};
}

/** Length (px) over which the top and the bottom of the selection fade out, at most a third of its height each. */
const SELECTION_FADE_PX = 8;

/**
 * Mask that fades what it covers out towards its top and bottom edge (a vertical opacity gradient), so the selection
 * has no hard upper and lower border. Returns the `mask` attribute value to use and the <defs> that define it.
 */
function useVerticalFade(top: number, bottom: number): { attr: string; defs: ReactElement } {
  const id = `fade${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const height = Math.max(1, bottom - top);
  const fade = Math.min(SELECTION_FADE_PX, height / 3) / height;
  return {
    attr: `url(#${id}m)`,
    defs: (
      <defs>
        <linearGradient id={`${id}g`} gradientUnits="userSpaceOnUse" x1="0" y1={r2(top)} x2="0" y2={r2(bottom)}>
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset={fade} stopColor="#fff" stopOpacity="1" />
          <stop offset={1 - fade} stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-100000" y={r2(top)} width="200000" height={r2(height)}>
          <rect x="-100000" y={r2(top)} width="200000" height={r2(height)} fill={`url(#${id}g)`} />
        </mask>
      </defs>
    ),
  };
}

/**
 * Selection band(s) behind the map (like the circular map's wedge): features keep their colours
 * and the band shows around them, over the backbone, the letters and the ruler.
 */
export const SelectionUnderlay = memo(function SelectionUnderlay({ view, selection }: SelectionProps) {
  const { selectionTop: top, selectionBottom: bottom } = view.v;
  const fade = useVerticalFade(top, bottom);
  if (!hasSelectedBases(selection) || view.seqLength <= 0) return null;
  return (
    <g data-testid="selection" mask={fade.attr}>
      {fade.defs}
      {selectionExtents(view, selection).map((p) => (
        <rect
          key={p.key}
          data-piece={p.key}
          className={styles.selection}
          x={r2(p.x0)}
          y={r2(top)}
          width={r2(p.x1 - p.x0)}
          height={r2(bottom - top)}
        />
      ))}
    </g>
  );
});

/** The caret of an empty selection, as tall as a selection band (a selected range has no edge lines: the band alone marks it). */
export const SelectionOverlay = memo(function SelectionOverlay({ view, selection }: SelectionProps) {
  if (!selection || view.seqLength <= 0) return null;
  const { scale, v, width, seqLength, topology } = view;
  const top = v.selectionTop;
  const bottom = v.selectionBottom;
  if (selection.range.end > selection.range.start) return null;
  const xs = caretPositions(selection.caret, seqLength, topology)
    .map((g) => scale.x(g))
    .filter((x) => x >= -2 && x <= width + 2);
  if (xs.length === 0) return null;
  return (
    <path
      data-testid="caret"
      className={styles.caret}
      d={xs.map((x) => `M${r2(Math.round(x * 2) / 2)} ${r2(top)}V${r2(bottom)}`).join('')}
    />
  );
});

/** Rings around the highlighted and hovered features; the hovered enzyme's label and cuts. */
export const HighlightLayer = memo(function HighlightLayer({
  ring,
  hoverRing,
  enzyme,
  enzymeCuts,
}: {
  ring: string;
  hoverRing: string;
  enzyme: EnzymeLabel | null;
  enzymeCuts: string;
}) {
  return (
    <>
      {hoverRing ? <path data-testid="hover-ring" className={styles.hoverRing} d={hoverRing} /> : null}
      {ring ? <path data-testid="highlight-ring" className={styles.ring} d={ring} /> : null}
      {enzymeCuts ? <path className={styles.cutHot} d={enzymeCuts} /> : null}
      {enzyme ? (
        <>
          <path className={styles.leaderHot} d={enzyme.leader} />
          <EnzymeText label={enzyme} hot />
        </>
      ) : null}
    </>
  );
});
