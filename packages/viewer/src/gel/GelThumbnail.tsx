/**
 * <GelThumbnail />: a compact, label-free preview of a gel (lists, inspectors, history items).
 */
import { useId, useMemo } from 'react';
import { GelBands, gelSvgId } from './GelBands';
import { computeGelLayout } from './layout';
import type { GelLane } from './types';
import styles from './GelView.module.css';

export interface GelThumbnailProps {
  lanes: readonly GelLane[];
  /** Size in px. Default 160 × 200. */
  width?: number;
  height?: number;
  className?: string;
  /** Accessible name. Default "Gel preview, N lanes". */
  'aria-label'?: string;
}

export function GelThumbnail({ lanes, width = 160, height = 200, className, 'aria-label': ariaLabel }: GelThumbnailProps) {
  const idBase = gelSvgId(useId());
  const layout = useMemo(() => computeGelLayout(lanes, { width, height, compact: true }), [lanes, width, height]);
  const label = ariaLabel ?? `Gel preview, ${lanes.length} lane${lanes.length === 1 ? '' : 's'}`;
  return (
    <div
      role="img"
      aria-label={label}
      className={[styles.thumbnail, className].filter(Boolean).join(' ')}
      style={{ width, height }}
    >
      <div
        className={`${styles.slab} ${styles.thumbSlab}`}
        style={{ left: layout.slab.x, top: layout.slab.y, width: layout.slab.width, height: layout.slab.height }}
      />
      <GelBands layout={layout} idBase={idBase} className={styles.layer} />
    </div>
  );
}
