import type { ReactNode } from 'react';
import type { Topology } from '@hhereditas/core';
import { cx } from '@hhereditas/ui';
import styles from './VisualizationPlaceholder.module.css';

export interface VisualizationPlaceholderProps {
  kind: 'map' | 'sequence';
  /** Map placeholders draw a ring (circular) or a bar (linear). */
  topology?: Topology;
  /** Centre label of the map, e.g. the document name. */
  title?: ReactNode;
  /** Second centre line, e.g. "3,938 bp". */
  subtitle?: ReactNode;
  className?: string;
}

const TICKS = Array.from({ length: 24 }, (_, i) => i);

/**
 * Neutral stand-in drawn where a visualization (circular/linear map, sequence view) will go:
 * the calm silhouette of the real thing, so the shell can be judged with realistic weight.
 */
export function VisualizationPlaceholder({ kind, topology = 'circular', title, subtitle, className }: VisualizationPlaceholderProps) {
  const name = kind === 'map' ? 'Map' : 'Sequence';
  if (kind === 'sequence') {
    return (
      <div className={cx(styles.root, styles.sequence, className)} role="img" aria-label={`${name} (placeholder)`}>
        <div className={styles.lines} aria-hidden>
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} className={styles.line}>
              <span className={styles.number} />
              <span className={styles.bases} style={i === 13 ? { width: '42%' } : undefined} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={cx(styles.root, styles.map, className)} role="img" aria-label={`${name} (placeholder)`}>
      {topology === 'circular' ? (
        <div className={styles.ringBox}>
          <svg viewBox="0 0 200 200" className={styles.ring} aria-hidden>
            <circle cx="100" cy="100" r="80" className={styles.backbone} />
            <circle cx="100" cy="100" r="77" className={styles.backboneInner} />
            {TICKS.map((i) => {
              const a = (i / TICKS.length) * Math.PI * 2;
              const major = i % 6 === 0;
              const r1 = 83;
              const r2 = major ? 89 : 86;
              return (
                <line
                  key={i}
                  x1={100 + r1 * Math.sin(a)}
                  y1={100 - r1 * Math.cos(a)}
                  x2={100 + r2 * Math.sin(a)}
                  y2={100 - r2 * Math.cos(a)}
                  className={major ? styles.majorTick : styles.tick}
                />
              );
            })}
          </svg>
          {title != null || subtitle != null ? (
            <div className={styles.center}>
              {title != null ? <div className={styles.title}>{title}</div> : null}
              {subtitle != null ? <div className={styles.subtitle}>{subtitle}</div> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles.linearBox}>
          {title != null ? <div className={styles.title}>{title}</div> : null}
          <svg viewBox="0 0 600 40" preserveAspectRatio="none" className={styles.linear} aria-hidden>
            <line x1="2" y1="20" x2="598" y2="20" className={styles.backbone} />
            {Array.from({ length: 11 }, (_, i) => (
              <line key={i} x1={2 + i * 59.6} y1="24" x2={2 + i * 59.6} y2={i % 5 === 0 ? 34 : 30} className={styles.tick} />
            ))}
          </svg>
          {subtitle != null ? <div className={styles.subtitle}>{subtitle}</div> : null}
        </div>
      )}
    </div>
  );
}
