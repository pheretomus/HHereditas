/**
 * SVG layers of the linear map. Each layer is memoized on the data it draws, so hovering or
 * moving the selection does not re-render the (much larger) map content.
 */
import { memo } from 'react';
import { FEATURE_LABEL_ON_FILL, featureStroke } from '../common/colors';
import type { SequenceSelection } from '../selection';
import type { EnzymeLabel, ViewModel } from './layout';
import styles from './LinearMap.module.css';
import { caretPositions, selectionPieces } from './selectionGeometry';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Everything that depends only on the view model (data + viewport + size). */
export const MapContent = memo(function MapContent({ view }: { view: ViewModel }) {
  const { v, backbone, letters, ticks, features, orfs, primers, enzymes } = view;
  return (
    <>
      {enzymes.leaders ? <path className={styles.leader} d={enzymes.leaders} /> : null}

      {/* ORFs and primers sit outside the feature lanes */}
      {orfs.small ? <path className={styles.orf} d={orfs.small} /> : null}
      {orfs.glyphs.map((g) => (
        <path key={g.key} className={styles.orf} d={g.d} />
      ))}
      {primers.glyphs.map((g) => (
        <g key={g.key}>
          {g.tail ? <path className={`${styles.primerTail} ${g.dir === 1 ? styles.primerTailFwd : styles.primerTailRev}`} d={g.tail} /> : null}
          {g.d ? <path className={g.dir === 1 ? styles.primerFwd : styles.primerRev} d={g.d} /> : null}
        </g>
      ))}
      {primers.labels.map((l) => (
        <text
          key={l.key}
          className={`${styles.primerLabel} ${styles.halo} ${l.dir === 1 ? styles.primerFwd : styles.primerRev}`}
          x={r2(l.x)}
          y={r2(l.y)}
          textAnchor={l.anchor}
          dominantBaseline="central"
        >
          {l.text}
        </text>
      ))}

      {/* features: density, slim bars, full glyphs, labels */}
      {features.density.map((p) => (
        <path key={p.key} d={p.d} style={{ fill: p.fill, opacity: p.opacity }} />
      ))}
      {features.small.map((p) => (
        <path key={p.key} d={p.d} style={{ fill: p.fill }} />
      ))}
      {features.glyphs.map((g) =>
        g.connector ? <path key={`${g.key}:c`} className={styles.connector} d={g.connector} /> : null,
      )}
      {features.glyphs.map((g) => (
        <path key={g.key} className={styles.feature} d={g.d} style={{ fill: g.fill, stroke: featureStroke(g.fill) }} />
      ))}
      {features.labels.map((l) => (
        <text
          key={l.key}
          className={l.placement === 'inside' ? styles.featureLabel : `${styles.featureLabel} ${styles.featureLabelOutside} ${styles.halo}`}
          style={l.placement === 'inside' ? { fill: FEATURE_LABEL_ON_FILL } : undefined}
          x={r2(l.x)}
          y={r2(l.y)}
          textAnchor={l.anchor}
          dominantBaseline="central"
        >
          {l.text}
        </text>
      ))}

      {/* backbone: two strands (one for RNA and protein), letters at high zoom */}
      {backbone.top ? <path className={styles.strand} d={`M${r2(backbone.top[0])} ${r2(v.topStrandY)}H${r2(backbone.top[1])}`} /> : null}
      {backbone.bottom ? (
        <path className={styles.strand} d={`M${r2(backbone.bottom[0])} ${r2(v.bottomStrandY)}H${r2(backbone.bottom[1])}`} />
      ) : null}
      {backbone.continuation ? <path className={styles.continuation} d={backbone.continuation} /> : null}
      {letters?.top ? (
        <text
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
      {ticks.minor ? <path className={styles.tickMinor} d={ticks.minor} /> : null}
      {ticks.major ? <path className={styles.tickMajor} d={ticks.major} /> : null}
      {ticks.labels.map((t) => (
        <text key={t.key} className={styles.tickLabel} x={r2(t.x)} y={r2(t.y)} textAnchor="middle" dominantBaseline="central">
          {t.text}
        </text>
      ))}

      {/* enzyme cuts and labels */}
      {enzymes.ticksUnlabelled ? <path className={styles.cutTickQuiet} d={enzymes.ticksUnlabelled} /> : null}
      {enzymes.ticks ? <path className={styles.cutTick} d={enzymes.ticks} /> : null}
      {enzymes.staggered ? <path className={styles.cutStaggered} d={enzymes.staggered} /> : null}
      {enzymes.labels.map((l) => (
        <EnzymeText key={l.key} label={l} />
      ))}
    </>
  );
});

function EnzymeText({ label, hot = false }: { label: EnzymeLabel; hot?: boolean }) {
  const cls = [styles.enzymeLabel, label.unique ? styles.enzymeLabelUnique : '', hot ? styles.enzymeHot : ''].filter(Boolean).join(' ');
  return (
    <text className={cls} x={r2(label.x)} y={r2(label.y)} textAnchor={label.anchor} dominantBaseline="central">
      {label.text}
    </text>
  );
}

/** Selection band(s) (two pieces when a circular selection wraps the origin) or the caret. */
export const SelectionLayer = memo(function SelectionLayer({
  view,
  selection,
}: {
  view: ViewModel;
  selection: SequenceSelection | null;
}) {
  if (!selection || view.seqLength <= 0) return null;
  const { scale, v, width, seqLength, topology } = view;
  const clampX = (x: number) => Math.min(width + 2, Math.max(-2, x));
  const top = v.bodyTop;
  const bottom = v.bodyBottom;
  if (selection.range.end > selection.range.start) {
    const pieces = selectionPieces(selection.range, seqLength, topology);
    return (
      <g data-testid="selection">
        {pieces.map((p) => {
          const x0 = clampX(scale.x(p.start));
          const x1 = clampX(scale.x(p.end));
          const w = Math.max(1, x1 - x0);
          let edges = '';
          if (p.startEdge && x0 > -2) edges += `M${r2(x0 + 0.5)} ${r2(top)}V${r2(bottom)}`;
          if (p.endEdge && x1 < width + 2) edges += `M${r2(x0 + w - 0.5)} ${r2(top)}V${r2(bottom)}`;
          return (
            <g key={`${p.start}-${p.end}`} data-piece={`${p.start}-${p.end}`}>
              <rect className={styles.selection} x={r2(x0)} y={r2(top)} width={r2(w)} height={r2(bottom - top)} />
              {edges ? <path className={styles.selectionEdge} d={edges} /> : null}
            </g>
          );
        })}
      </g>
    );
  }
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
