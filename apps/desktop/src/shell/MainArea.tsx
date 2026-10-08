import { useRef, type ReactNode } from 'react';
import type { Topology } from '@hhereditas/core';
import { useElementSize } from '@hhereditas/viewer';
import { SplitPane, SplitView, cx, useControllableState } from '@hhereditas/ui';
import type { ViewMode } from './types';
import { VisualizationPlaceholder } from './VisualizationPlaceholder';
import styles from './MainArea.module.css';

export interface MainAreaProps {
  view: ViewMode;
  /** The map (CircularMap / LinearMap). Default: a neutral placeholder. */
  map?: ReactNode;
  /** The sequence view. Default: a neutral placeholder. */
  sequence?: ReactNode;
  /** Shape of the placeholder map. */
  topology?: Topology;
  /** Centre text of the placeholder map (e.g. the document name and length). */
  placeholderTitle?: ReactNode;
  placeholderSubtitle?: ReactNode;
  /** Share of the height given to the map in split view, 0..1 (controlled). */
  splitRatio?: number;
  /** Initial share when uncontrolled (default 0.46). */
  defaultSplitRatio?: number;
  /** Called while the divider between map and sequence is dragged. */
  onSplitRatioChange?: (ratio: number) => void;
  /** Inline message above the visualization (e.g. a read-only Banner). */
  banner?: ReactNode;
  className?: string;
}

const MAP_MIN = 160;
const SEQUENCE_MIN = 120;

/**
 * The document canvas. Map, Sequence, or Split (map above sequence with a draggable
 * divider). Both visualizations stay mounted while hidden, so switching views is instant and
 * keeps their scroll position and zoom.
 */
export function MainArea({
  view,
  map,
  sequence,
  topology = 'circular',
  placeholderTitle,
  placeholderSubtitle,
  splitRatio,
  defaultSplitRatio = 0.46,
  onSplitRatioChange,
  banner,
  className,
}: MainAreaProps) {
  const panesRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(panesRef);
  const [ratio, setRatio] = useControllableState(splitRatio, defaultSplitRatio, onSplitRatioChange);
  const split = view === 'split';
  // Pixel size of the map pane in split view, from the ratio (kept proportional on resize).
  const usable = Math.max(0, height);
  const mapPx = Math.round(Math.min(Math.max(ratio * usable, MAP_MIN), Math.max(MAP_MIN, usable - SEQUENCE_MIN)));

  return (
    <div className={cx(styles.main, className)} data-view={view}>
      {banner ? <div className={styles.banner}>{banner}</div> : null}
      <div ref={panesRef} className={styles.panes}>
        <SplitView orientation="vertical" animated={false}>
          <SplitPane
            id="map"
            label="Map"
            size={split ? mapPx : undefined}
            minSize={split ? MAP_MIN : 0}
            collapsed={view === 'sequence'}
            onSizeChange={(px) => {
              if (usable > 0) setRatio(Math.min(0.9, Math.max(0.1, px / usable)));
            }}
            className={styles.pane}
          >
            {map ?? (
              <VisualizationPlaceholder kind="map" topology={topology} title={placeholderTitle} subtitle={placeholderSubtitle} />
            )}
          </SplitPane>
          <SplitPane id="sequence" label="Sequence" minSize={split ? SEQUENCE_MIN : 0} collapsed={view === 'map'} className={styles.pane}>
            {sequence ?? <VisualizationPlaceholder kind="sequence" />}
          </SplitPane>
        </SplitView>
      </div>
    </div>
  );
}
