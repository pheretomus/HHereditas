/**
 * The photographic part of the gel: wells and soft-edged bands (or smears), drawn from a
 * precomputed {@link GelLayout}. Shared by GelView and GelThumbnail; memoized so that hover and
 * selection changes never re-render (or re-blur) the bands.
 */
import { memo } from 'react';
import type { GelLayout } from './layout';
import styles from './GelView.module.css';

export interface GelBandsProps {
  layout: GelLayout;
  /** Unique prefix for the SVG filter / clip-path ids. */
  idBase: string;
  className?: string;
}

/** Turns a React id (which may contain ':' or '«»') into a safe SVG id prefix. */
export function gelSvgId(reactId: string): string {
  return `hh-gel-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export const GelBands = memo(function GelBands({ layout, idBase, className }: GelBandsProps) {
  const { slab, blur, lanes } = layout;
  const softId = `${idBase}-soft`;
  const glowId = `${idBase}-glow`;
  const clipId = `${idBase}-clip`;
  const hasGlow = lanes.some((l) => !l.smear && l.bands.some((b) => b.glow > 0.01));
  const region = { x: slab.x, y: slab.y, width: slab.width, height: slab.height };
  return (
    <svg
      className={className}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect {...region} />
        </clipPath>
        <filter id={softId} filterUnits="userSpaceOnUse" {...region} colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation={`${blur.x} ${blur.y}`} />
        </filter>
        {hasGlow && (
          <filter id={glowId} filterUnits="userSpaceOnUse" {...region} colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation={blur.glow} />
          </filter>
        )}
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <g>
          {lanes.map((lane) => (
            <rect
              key={lane.index}
              className={styles.well}
              x={lane.well.x}
              y={lane.well.y}
              width={lane.well.width}
              height={lane.well.height}
              rx={Math.min(1.5, lane.well.height / 2)}
            />
          ))}
        </g>
        {hasGlow && (
          <g filter={`url(#${glowId})`}>
            {lanes.map((lane) =>
              lane.smear
                ? null
                : lane.bands.map((b, i) =>
                    b.glow > 0.01 ? (
                      <rect
                        key={`${lane.index}:${i}`}
                        className={styles.glow}
                        x={lane.bandLeft - 2}
                        y={b.y - b.height * 0.95}
                        width={lane.bandWidth + 4}
                        height={b.height * 1.9}
                        rx={b.height}
                        fillOpacity={b.glow}
                      />
                    ) : null,
                  ),
            )}
          </g>
        )}
        <g filter={`url(#${softId})`}>
          {lanes.map((lane) =>
            lane.smear
              ? lane.smear.map((s, i) => (
                  <rect
                    key={`${lane.index}:s${i}`}
                    className={styles.smear}
                    x={lane.bandLeft}
                    y={s.y}
                    width={lane.bandWidth}
                    height={s.height}
                    fillOpacity={s.alpha}
                  />
                ))
              : lane.bands.map((b, i) => (
                  <rect
                    key={`${lane.index}:${i}`}
                    className={styles.band}
                    x={lane.bandLeft}
                    y={b.y - b.height / 2}
                    width={lane.bandWidth}
                    height={b.height}
                    rx={Math.min(b.height / 2, layout.compact ? 0.75 : 1.75)}
                    fillOpacity={b.alpha}
                  />
                )),
          )}
        </g>
      </g>
    </svg>
  );
});
