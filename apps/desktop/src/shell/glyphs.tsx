/**
 * Small 16 px glyphs for lists: a feature swatch shaped like the feature's arrow (colour +
 * strand at a glance), a primer half-arrow, and a document mark showing its topology.
 * Colours come from tokens / feature colours through `style` (WebKit ignores var() in SVG
 * presentation attributes).
 */
import type { Strand, Topology } from '@hhereditas/core';
import { featureStroke } from '@hhereditas/viewer';
import { cx } from '@hhereditas/ui';
import styles from './glyphs.module.css';

const FEATURE_PATHS: Record<'1' | '-1' | '0', string> = {
  // pentagon pointing right, rounded tail
  '1': 'M3.2 2.5H10.4L14.6 6L10.4 9.5H3.2Q1.6 9.5 1.6 7.9V4.1Q1.6 2.5 3.2 2.5Z',
  // pentagon pointing left
  '-1': 'M12.8 2.5H5.6L1.4 6L5.6 9.5H12.8Q14.4 9.5 14.4 7.9V4.1Q14.4 2.5 12.8 2.5Z',
  // no strand: rounded rectangle
  '0': 'M3.2 2.5H12.8Q14.4 2.5 14.4 4.1V7.9Q14.4 9.5 12.8 9.5H3.2Q1.6 9.5 1.6 7.9V4.1Q1.6 2.5 3.2 2.5Z',
};

export interface FeatureGlyphProps {
  /** CSS colour of the feature (see featureFill). */
  color: string;
  strand: Strand;
  className?: string;
}

/** Feature colour swatch drawn as a tiny arrow in the feature's direction. */
export function FeatureGlyph({ color, strand, className }: FeatureGlyphProps) {
  return (
    <svg viewBox="0 0 16 12" width={16} height={12} className={cx(styles.feature, className)} aria-hidden>
      <path d={FEATURE_PATHS[String(strand) as '1' | '-1' | '0']} style={{ fill: color, stroke: featureStroke(color) }} />
    </svg>
  );
}

/** Oligo mark: a line with a half arrowhead (5'→3'). */
export function PrimerGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} className={cx(styles.primer, className)} aria-hidden>
      <path d="M1.75 10.25H14.25L10.25 6.25" />
    </svg>
  );
}

/** Document mark: a ring for circular molecules, a bar for linear ones. Uses currentColor. */
export function DocumentGlyph({ topology, className }: { topology: Topology; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} className={cx(styles.document, className)} aria-hidden>
      {topology === 'circular' ? (
        <>
          <circle cx="8" cy="8" r="5.75" className={styles.track} />
          <path d="M8 2.25A5.75 5.75 0 0 1 13.47 9.78" className={styles.arc} />
        </>
      ) : (
        <>
          <path d="M1.75 8H14.25M1.75 5.5V10.5M14.25 5.5V10.5" className={styles.track} />
          <path d="M5 8H10.5" className={styles.arc} />
        </>
      )}
    </svg>
  );
}
